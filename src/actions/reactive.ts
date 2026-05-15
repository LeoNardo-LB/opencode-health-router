import type { ModelKey } from "../types.js"
import type { HealthStore } from "../health/store.js"
import type { ModelSelector } from "../selection/selector.js"
import type { Logger } from "../logging/logger.js"
import { classify } from "../classification/classifier.js"
import { shouldIntervene } from "../retry/policy.js"
import { RetryCounter } from "../retry/counter.js"
import { splitModelKey } from "../types.js"
import type { ClassificationRule } from "../types.js"

interface OpencodeClient {
  session: {
    abort(params: { path: { id: string } }): Promise<unknown>
    revert(params: { path: { id: string }; body: { messageID: string } }): Promise<unknown>
    prompt(params: {
      path: { id: string }
      body: { model: { providerID: string; modelID: string }; agent?: string; parts: unknown[] }
    }): Promise<unknown>
    messages(params: { path: { id: string } }): Promise<{ data?: Array<{
      info: { id: string; role: string; model?: { providerID: string; modelID: string }; agent?: string }
      parts: unknown[]
    }> }>
  }
  tui?: { showToast(params: { body: { message: string; variant?: string } }): Promise<boolean> }
}

interface ReactiveContext {
  client: OpencodeClient
  store: HealthStore
  selector: ModelSelector
  rules: ClassificationRule[]
  maxRetries: number
  /** Per-model retry counter for serve-mode attempt tracking */
  retryCounter?: RetryCounter
  logger: Logger
  dedupSet: Set<string>
  pluginPromptedSessions: Set<string>
  messageCache: Map<string, Array<{ modelKey: string; agentName: string; messageID: string }>>
  /** Per-model retry counter for serve-mode attempt tracking */
  retryCounter?: RetryCounter
  /** Anti-cascading: prevents re-processing retry events after a fallback chain has already executed */
  handledRetrySessions: Set<string>
  /** Set of child session IDs (subagents) — used to detect subagent sessions */
  childSessions?: Set<string>
  /** Set of aborted child session IDs — consumed by tool.execute.after hook */
  abortedChildren?: Set<string>
}

const DEDUP_MAX_SIZE = 10_000

/** 清理指定 sessionID 的所有去重键 (spec §8.3: session.deleted/compacted 事件触发) */
export function cleanupDedupForSession(dedupSet: Set<string>, sessionID: string): void {
  const prefix = `${sessionID}:`
  for (const key of dedupSet) {
    if (key.startsWith(prefix)) dedupSet.delete(key)
  }
}

/** 容量上限清理：超出 10000 条时清理最旧 50% (spec §8.3) */
export function cleanupDedupBySize(dedupSet: Set<string>): void {
  if (dedupSet.size <= DEDUP_MAX_SIZE) return
  const toDelete = Math.ceil(dedupSet.size * 0.5)
  let count = 0
  for (const key of dedupSet) {
    if (count >= toDelete) break
    dedupSet.delete(key)
    count++
  }
}

export async function handleReactiveEvent(
  event: { type: string; properties?: { status?: { type?: string; attempt?: number; message?: string }; sessionID?: string } },
  ctx: ReactiveContext,
): Promise<void> {
  if (!event || event.type !== "session.status") return
  const status = event.properties?.status
  if (status?.type !== "retry") return

  const { attempt = 1, message = "", sessionID } = { ...status, sessionID: event.properties?.sessionID ?? "" }
  if (!sessionID) return

  ctx.logger.debug("reactive.retry_event", { sessionID, attempt, message: message.slice(0, 100) })

  // ⓪ Anti-cascading: atomic check-and-set BEFORE any await
  // Moving add() here closes the race window — concurrent retry events will see
  // the flag and return immediately.  Non-abort early-return paths delete the
  // flag so that subsequent retry events get a chance to handle.
  if (ctx.handledRetrySessions.has(sessionID)) {
    ctx.logger.debug("reactive.already_handled", { sessionID, attempt })
    return
  }
  ctx.handledRetrySessions.add(sessionID)

  // ① Classify
  const classification = classify(message, ctx.rules)
  if (!classification) {
    ctx.logger.debug("reactive.classify_miss", { sessionID, message: message.slice(0, 100) })
    ctx.handledRetrySessions.delete(sessionID)
    return
  }

  // ② Retry gate — use plugin-side counter for serve mode
  // OpenCode serve always emits attempt=1 with new sessionID per retry.
  // We count consecutive failures per model within a time window.
  const cacheStack = ctx.messageCache.get(sessionID)
  const peekModel = cacheStack && cacheStack.length > 0 ? cacheStack[cacheStack.length - 1].modelKey : undefined
  let effectiveAttempt = attempt
  if (peekModel && ctx.retryCounter) {
    effectiveAttempt = ctx.retryCounter.increment(peekModel)
    ctx.logger.debug("reactive.counter_incremented", { sessionID, model: peekModel, count: effectiveAttempt })
  }
  if (!shouldIntervene(effectiveAttempt, ctx.maxRetries)) {
    ctx.logger.debug("reactive.retry_gate", { sessionID, attempt, effectiveAttempt, maxRetries: ctx.maxRetries })
    ctx.handledRetrySessions.delete(sessionID)
    return
  }

  // 子会话分支：abort-only，不走 revert+prompt
  // 原因：revert 会删除消息导致 lastAssistant 读不到最新 assistant 消息，
  //       prompt 会创建新 messageID 打断 task 工具的内部链路。
  //       只 abort → onInterrupt → lastAssistant → task 正常返回。
  if (ctx.childSessions?.has(sessionID)) {
    // Record failure using the cache stack directly (lastUserMessageID not available yet)
    const stack = ctx.messageCache.get(sessionID)
    if (stack && stack.length > 0) {
      const lastEntry = stack[stack.length - 1]
      ctx.store.recordFailure(lastEntry.modelKey)
      ctx.logger.info("reactive.child_failure_recorded", {
        sessionID,
        model: lastEntry.modelKey,
        score: ctx.store.get(lastEntry.modelKey),
        category: classification.category,
      })
    }
    // Abort without revert/prompt — onInterrupt handles cleanup.
    // abortedChildren.add() and cache cleanup are deferred until abort succeeds
    // to prevent phantom entries and ensure retry-after-abort-failure has data.
    try {
      await ctx.client.session.abort({ path: { id: sessionID } })
      ctx.abortedChildren?.add(sessionID)
      // Consume cache entry to prevent memory leak (mirrors main-session splice)
      if (stack && stack.length > 0) {
        stack.pop()
        if (stack.length === 0) ctx.messageCache.delete(sessionID)
      }
      ctx.logger.info("reactive.child_aborted", { sessionID })
      // Reset counter — this model triggered intervention, no need to keep counting
      if (peekModel && ctx.retryCounter) {
        ctx.retryCounter.reset(peekModel)
        ctx.logger.debug("reactive.counter_reset_child", { sessionID, model: peekModel })
      }
    } catch (err) {
      ctx.logger.error("reactive.child_abort_failed", { sessionID, error: String(err) })
      // Clean up anti-cascading flag so future retry events can be processed.
      // Without this, a transient abort failure permanently suppresses all
      // retry handling for this session.
      ctx.handledRetrySessions.delete(sessionID)
      return
    }
    return
  }

  // ③ Get last user message from messages API (needed for messageID + parts)
  let promptParts: unknown[]
  let lastUserMessageID: string | undefined
  try {
    const result = await ctx.client.session.messages({ path: { id: sessionID } })
    const entries: any[] = Array.isArray((result as any).data) ? (result as any).data : []
    const lastUser = [...entries].reverse().find((e) => e?.info?.role === "user")
    promptParts = lastUser?.parts ?? []
    lastUserMessageID = lastUser?.info?.id
    if (!Array.isArray(promptParts)) promptParts = []
    ctx.logger.debug("reactive.messages_ok", { sessionID, count: entries.length, parts: promptParts.length, lastUserMessageID })
  } catch (err) {
    ctx.logger.error("reactive.messages_failed", { sessionID, error: String(err) })
    ctx.handledRetrySessions.delete(sessionID)
    return
  }

  if (promptParts.length === 0) {
    promptParts = [{ type: "text", text: "" }]
    ctx.logger.warn("reactive.empty_parts", { sessionID })
  }

  if (!lastUserMessageID) {
    ctx.logger.warn("reactive.no_last_user_message", { sessionID })
    ctx.handledRetrySessions.delete(sessionID)
    return
  }

  // ④ Find matching cache entry by messageID (stack lookup)
  const stack = ctx.messageCache.get(sessionID)
  let cachedIdx = stack?.findIndex(e => e.messageID === lastUserMessageID)

  // Headless 模式 fallback：当 chat.message hook 收到 null messageID 时，
  // cache entry 以空字符串存储。精确匹配失败后，只在 stack 最后一项
  // 的 messageID 为空字符串（headless 标记）时才 fallback 匹配。
  if ((cachedIdx === undefined || cachedIdx === -1) && stack && stack.length > 0) {
    const lastEntry = stack[stack.length - 1]
    if (lastEntry.messageID === "") {
      cachedIdx = stack.length - 1
      ctx.logger.debug("reactive.cache_fallback_match", {
        sessionID,
        lastUserMessageID,
        matchedModel: lastEntry.modelKey,
        matchedAgent: lastEntry.agentName,
        stackSize: stack.length,
      })
    }
  }

  if (cachedIdx === undefined || cachedIdx === -1 || !stack) {
    ctx.logger.warn("reactive.no_cache_match", { sessionID, lastUserMessageID, stackSize: stack?.length ?? 0 })
    ctx.handledRetrySessions.delete(sessionID)
    return
  }
  const cached = stack[cachedIdx]
  // Remove consumed entry from stack to prevent memory leak
  stack.splice(cachedIdx, 1)
  if (stack.length === 0) ctx.messageCache.delete(sessionID)

  const currentModelKey: ModelKey = cached.modelKey
  const agentName = cached.agentName
  const userMessageID = cached.messageID

  // ⑤ Dedup (includes messageID to avoid cross-message collision)
  const dedupKey = `${sessionID}:${lastUserMessageID}:${attempt}`
  if (ctx.dedupSet.has(dedupKey)) {
    ctx.logger.debug("reactive.dedup_hit", { sessionID, lastUserMessageID, attempt })
    ctx.handledRetrySessions.delete(sessionID)
    return
  }
  ctx.dedupSet.add(dedupKey)

  // ⑥ Record failure
  ctx.store.recordFailure(currentModelKey)
  ctx.logger.info("reactive.failure_recorded", {
    sessionID,
    model: currentModelKey,
    score: ctx.store.get(currentModelKey),
    category: classification.category,
  })
  let excludedProvider: string | undefined

  switch (classification.category) {
    case "5xx": {
      // 服务端错误：立即切换，不等待 OpenCode 再重试其他 server
      ctx.logger.debug("reactive.category_branch", { sessionID, category: "5xx", action: "immediate" })
      // 扣分加重？TODO: 可考虑 failurePenalty * 1.5
      break
    }
    case "overloaded": {
      // 服务过载：当前模型短暂不可用，正常扣分
      ctx.logger.debug("reactive.category_branch", { sessionID, category: "overloaded", action: "normal" })
      break
    }
    case "rate_limit": {
      // 频率限制：当前模型请求太密，正常扣分
      ctx.logger.debug("reactive.category_branch", { sessionID, category: "rate_limit", action: "normal" })
      break
    }
    case "quota_exceeded": {
      // 配额耗尽：同厂商模型全部不可用，需要过滤
      excludedProvider = splitModelKey(currentModelKey).providerID
      ctx.logger.debug("reactive.category_branch", { sessionID, category: "quota_exceeded", action: "exclude_provider", excludedProvider })
      break
    }
    case "timeout": {
      // 超时：可能网络波动，正常扣分
      ctx.logger.debug("reactive.category_branch", { sessionID, category: "timeout", action: "normal" })
      break
    }
    default: {
      ctx.logger.debug("reactive.category_branch", { sessionID, category: classification.category, action: "unknown" })
      break
    }
  }

  // ⑦ Select fallback
  const nextKey = ctx.selector.resolve(agentName, excludedProvider ? { excludeProvider: excludedProvider } : undefined)
  if (!nextKey) {
    ctx.logger.warn("reactive.chain_exhausted", { sessionID, agentName })
    if (ctx.client.tui) {
      try { await ctx.client.tui.showToast({ body: { message: "所有 fallback 模型已耗尽", variant: "error" } }) } catch { /* ignore */ }
    }
    ctx.handledRetrySessions.delete(sessionID)
    return
  }

  // Avoid switching to the same model that just failed
  if (nextKey === currentModelKey) {
    ctx.logger.warn("reactive.same_model", { sessionID, model: currentModelKey })
    ctx.pluginPromptedSessions.delete(sessionID)
    if (ctx.client.tui) {
      try { await ctx.client.tui.showToast({ body: { message: `${currentModelKey} 无其他可用 fallback`, variant: "warning" } }) } catch { /* ignore */ }
    }
    ctx.handledRetrySessions.delete(sessionID)
    return
  }

  // ⑧ Execute switch
  try {
    await ctx.client.session.abort({ path: { id: sessionID } })
  } catch (err) {
    ctx.logger.error("reactive.abort_failed", { sessionID, error: String(err) })
    ctx.handledRetrySessions.delete(sessionID)
    return
  }

  // Anti-cascading: flag was set at function entry (before all awaits).
  // abort() is irreversible — the fallback chain is now executing, so subsequent
  // retry events for this session must be skipped to avoid a waterfall of
  // abort+revert+prompt calls.  The flag stays set until chat.message hook
  // (user or plugin-prompt branch) clears it.

  try {
    await ctx.client.session.revert({
      path: { id: sessionID },
      body: { messageID: userMessageID },
    })
  } catch (err) {
    // 跳过 revert，对话历史可能残留失败回复，但不阻断 (spec §5.7/§8.2)
    ctx.logger.warn("reactive.revert_skipped", { sessionID, error: String(err) })
  }

  const { providerID, modelID } = splitModelKey(nextKey)

  // Mark as plugin-triggered prompt so chat.message uses score mechanism
  ctx.pluginPromptedSessions.add(sessionID)
  try {
    await ctx.client.session.prompt({
      path: { id: sessionID },
      body: {
        model: { providerID, modelID },
        parts: promptParts,
      },
    })
    // Success: chat.message hook will consume and clean the marker
    ctx.logger.info("reactive.fallback_success", {
      sessionID,
      from: currentModelKey,
      to: nextKey,
      agent: agentName,
    })

    // Reset counter for original model — we've switched away, no need to keep counting
    if (ctx.retryCounter) {
      ctx.retryCounter.reset(currentModelKey)
      ctx.logger.debug("reactive.counter_reset_fallback", { sessionID, model: currentModelKey })
    }

    if (ctx.client.tui) {
      try {
        await ctx.client.tui.showToast({ body: { message: `${currentModelKey} ${classification.category} → ${nextKey}`, variant: "warning" } })
      } catch { /* tui might not be available */ }
    }
  } catch (err) {
    // Failure: chat.message won't trigger, manually clean markers to prevent residue
    ctx.pluginPromptedSessions.delete(sessionID)
    ctx.handledRetrySessions.delete(sessionID)  // Unlock — allow retry after prompt failure
    ctx.logger.error("reactive.prompt_failed", { sessionID, nextKey, error: String(err) })
  }
}
