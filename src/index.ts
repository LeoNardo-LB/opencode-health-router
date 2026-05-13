import type { Plugin } from "@opencode-ai/plugin"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { parseJSONC } from "./jsonc.js"
import { loadConfig } from "./config/loader.js"
import { generateTemplate } from "./config/generator.js"
import { createLogger } from "./logging/logger.js"
import type { Logger } from "./logging/logger.js"
import { HealthStore } from "./health/store.js"
import { ModelSelector } from "./selection/selector.js"
import { handleChatMessage } from "./actions/preemptive.js"
import { handleReactiveEvent, cleanupDedupForSession, cleanupDedupBySize } from "./actions/reactive.js"

// ─── Exported testable handlers (P3 + P5) ─────────────────────────────────

/** P3: Track child sessions (subagents) by parentID on session.created events */
export function handleSessionCreated(
  event: { type: string; properties?: { sessionID?: string; info?: { parentID?: string } } },
  childSessions: Set<string>,
  logger: Logger,
): void {
  if (event.type !== "session.created") return
  const props = event.properties
  const info = props?.info
  const sessionID = props?.sessionID
  if (info?.parentID && sessionID) {
    childSessions.add(sessionID)
    logger.debug("session.child_detected", {
      sessionID,
      parentID: info.parentID,
    })
  }
}

/** P5: Enhance task tool output with 429 context for aborted child sessions */
export function handleToolExecuteAfter(
  input: { tool: string; sessionID?: string },
  output: { output?: unknown; metadata?: unknown },
  abortedChildren: Set<string>,
  logger: Logger,
): void {
  if (input.tool !== "task") return

  const metadata = output.metadata as Record<string, unknown> | undefined
  const childSessionID = metadata?.sessionId as string | undefined
  if (!childSessionID) return

  if (!abortedChildren.has(childSessionID)) return
  abortedChildren.delete(childSessionID)

  const currentOutput = String(output.output || "")
  const modelInfo = metadata?.model as { providerID?: string; modelID?: string } | undefined
  const modelName = modelInfo ? `${modelInfo.providerID}/${modelInfo.modelID}` : "模型"

  output.output = [
    currentOutput,
    "",
    "---",
    `⚠️ 子会话 ${childSessionID} 因 ${modelName} 429 限流中断`,
    `重试时请在新子会话中执行: opencode export ${childSessionID} 2>&1 | tail -200`,
    `查看方法: 看第一句(任务目标) + 最后几句(已完成的工作)`,
  ].join("\n")

  logger.info("tool.after.task_enhanced", {
    parentSessionID: input.sessionID,
    childSessionID,
  })
}

// ─── Module-level shared state ──────────────────────────────────────────
// OpenCode creates two plugin instances per project (calls server() twice).
// These variables MUST live at module level so both instances share the same
// state; otherwise instance A's reactive handler sets flags that instance B's
// chat.message hook cannot see.
//
// Lazy-initialised on first server() call; subsequent calls reuse them.

let sharedStore: HealthStore | null = null
let sharedSelector: ModelSelector | null = null
let sharedDedupSet: Set<string> | null = null
let sharedPluginPromptedSessions: Set<string> | null = null
let sharedHandledRetrySessions: Set<string> | null = null
let sharedMessageCache: Map<string, Array<{ modelKey: string; agentName: string; messageID: string }>> | null = null
let sharedChildSessions: Set<string> | null = null
let sharedAbortedChildren: Set<string> | null = null
let tickTimerStarted = false

export default {
  id: 'opencode-health-router',

  server: async ({ client, directory }: { client: any; directory: string }) => {

  // Phase 1: Load config
  const logger = createLogger()
  logger.info("plugin.server_entered", { directory, platform: process.platform })

  // Get config directory (local calculation — client.path.get() triggers Bun N-API panic)
  const configDir = process.platform === "win32"
    ? path.join(process.env.APPDATA || os.homedir(), "opencode")
    : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"))
  logger.info("plugin.config_dir", { configDir })

  // Auto-generate template config if no config file exists
  const opencodePath = [path.join(configDir, "opencode", "opencode.jsonc"), path.join(configDir, "opencode", "opencode.json")].find(p => fs.existsSync(p))
  logger.debug("plugin.opencode_config_search", { opencodePath })
  let opencodeConfig: unknown = undefined
  if (opencodePath) {
    try {
      opencodeConfig = parseJSONC(fs.readFileSync(opencodePath, "utf-8"))
      logger.debug("plugin.opencode_config_parsed", { path: opencodePath })
    } catch (e: any) {
      logger.warn("plugin.opencode_config_parse_failed", { path: opencodePath, error: String(e) })
    }
  }
  const templateResult = generateTemplate(logger, opencodeConfig, configDir)
  logger.debug("plugin.template_generation", { templateResult })

  const { config, configPath, warnings } = loadConfig(logger, directory, configDir)
  logger.info("plugin.config_loaded", { configPath, enabled: config.enabled, warningsCount: warnings.length })

  if (warnings.length > 0) {
    for (const w of warnings) logger.warn("config.warning", { warning: w })
  }
  if (!config.enabled) {
    logger.info("plugin.disabled")
    return {}
  }
  logger.info("plugin.started", { configPath: configPath ?? "defaults", agentCount: Object.keys(config.agents).length })

  // Phase 2: Initialize (or reuse) shared components
  // First instance creates them; subsequent instances reuse the same objects.
  if (!sharedStore) sharedStore = new HealthStore(config)
  if (!sharedSelector) sharedSelector = new ModelSelector(config, sharedStore)
  if (!sharedDedupSet) sharedDedupSet = new Set<string>()
  if (!sharedPluginPromptedSessions) sharedPluginPromptedSessions = new Set<string>()
  // Anti-cascading: prevent reactive handler from processing the same retry cycle twice
  // (set when fallback chain completes, cleared when new user message arrives)
  if (!sharedHandledRetrySessions) sharedHandledRetrySessions = new Set<string>()
  // Cache user message metadata keyed by sessionID — used by reactive handler
  // to read the ORIGINAL model (not the fallback model from a prior prompt() call)
  if (!sharedMessageCache) sharedMessageCache = new Map<string, Array<{ modelKey: string; agentName: string; messageID: string }>>()
  if (!sharedChildSessions) sharedChildSessions = new Set<string>()
  if (!sharedAbortedChildren) sharedAbortedChildren = new Set<string>()

  const store = sharedStore
  const selector = sharedSelector
  const dedupSet = sharedDedupSet
  const pluginPromptedSessions = sharedPluginPromptedSessions
  const handledRetrySessions = sharedHandledRetrySessions
  const messageCache = sharedMessageCache
  const childSessions = sharedChildSessions
  const abortedChildren = sharedAbortedChildren

  logger.debug("plugin.components_initialized", {
    agents: Object.keys(config.agents),
    primaryModels: [...config.primaryModels],
    rulesCount: config.classification.rules.length,
  })

  // Phase 3: Start health tick timer + dedup capacity cleanup (once only)
  if (!tickTimerStarted) {
    tickTimerStarted = true
    const tickTimer = setInterval(() => {
      store.tick()
      // Dedup capacity cleanup: clear oldest 50% when exceeding 10000 (spec §8.3)
      cleanupDedupBySize(dedupSet)
    }, 30_000)
    if (tickTimer.unref) tickTimer.unref()
  }

  // Phase 4: Listen for successful completions to record success
  // EventMessageUpdated has { type: "message.updated", properties: { info: Message } }
  // AssistantMessage (role "assistant") has providerID, modelID, time.completed
  const recordSuccessOnComplete = (event: { type: string; properties?: unknown }) => {
    if (event.type !== "message.updated") return
    const props = event.properties as { info?: { role?: string; providerID?: string; modelID?: string; time?: { completed?: number } } } | undefined
    const info = props?.info
    if (!info || info.role !== "assistant") return
    if (info.time?.completed && info.providerID && info.modelID) {
      const key = `${info.providerID}/${info.modelID}`
      store.recordSuccess(key)
      logger.debug("health.success_recorded", { model: key, score: store.get(key) })
    }
  }

  logger.info("plugin.hooks_returning", { hooks: ["chat.message", "event", "tool.execute.after"] })

  return {
    "chat.message": async (input: any, output: any) => {
      if (!input) return
      const sessionID = input.sessionID

      // Cache for reactive handler — ALL messages must be cached before any branching
      // so that fallback-to-fallback chains work (the plugin-prompted message also needs
      // a cache entry in case the fallback model also fails and triggers another retry).
      //
      // In headless/CLI mode (opencode run), input.model may be null.
      // Fall back to the agent's default model from opencode.jsonc config.
      const agentName = input.agent || "*"
      let modelKey: string | undefined
      if (input.model?.providerID && input.model?.modelID) {
        modelKey = `${input.model.providerID}/${input.model.modelID}`
      } else if (config.agentModels[agentName]) {
        modelKey = config.agentModels[agentName]
        logger.debug("preemptive.model_resolved_from_agent", { sessionID, agentName, modelKey })
      }
      if (modelKey) {
        // headless/CLI 模式下 input.messageID 可能为 null，
        // 用空字符串作为标记，reactive handler 会通过 fallback 查找匹配
        const cacheMessageID = input.messageID || ""
        const entry = {
          modelKey,
          agentName,
          messageID: cacheMessageID,
        }
        const stack = messageCache.get(sessionID)
        if (stack) {
          stack.push(entry)
        } else {
          messageCache.set(sessionID, [entry])
        }
        if (!input.messageID) {
          logger.debug("preemptive.cached_without_messageID", { sessionID, agentName, modelKey })
        }
      } else if (!modelKey) {
        logger.warn("preemptive.no_model", { sessionID, agentName, hasMessageID: !!input.messageID })
      }

      // All messages → health score check (no trust branch)
      if (pluginPromptedSessions.has(sessionID)) {
        pluginPromptedSessions.delete(sessionID)
        // V1 fix: also clear handledRetrySessions on plugin-prompt branch so that
        // fallback-to-fallback chains are not blocked.  The fallback request has
        // already started a new message cycle — if it also fails, the new retry
        // event must be allowed to trigger the next fallback.
        handledRetrySessions.delete(sessionID)
        logger.debug("preemptive.plugin_prompt", { sessionID, model: input.model ? `${input.model.providerID}/${input.model.modelID}` : null })
      } else {
        // New user message: reset anti-cascading flag so next retry cycle can be handled
        handledRetrySessions.delete(sessionID)
        logger.debug("preemptive.user_message", { sessionID, agent: input.agent, model: input.model ? `${input.model.providerID}/${input.model.modelID}` : null })
      }

      handleChatMessage(
        input as Parameters<typeof handleChatMessage>[0],
        output as Parameters<typeof handleChatMessage>[1],
        store,
        config,
        logger,
      )
    },

    event: async ({ event }: { event: any }) => {
      logger.debug("event.received", { type: event.type })
      // Record successes
      recordSuccessOnComplete(event as unknown as { type: string; properties?: unknown })

      // Dedup cleanup on session lifecycle events (spec §8.3)
      if (event.type === "session.deleted" || event.type === "session.compacted") {
        const sessionID = (event.properties as { sessionID?: string } | undefined)?.sessionID
        if (sessionID) cleanupDedupForSession(dedupSet, sessionID)
      }

      // Track child sessions (subagents) by parentID (P3)
      handleSessionCreated(event, childSessions!, logger)

      // Only clean session-level sets on session.deleted
      if (event.type === "session.deleted") {
        const sessionID = (event.properties as { sessionID?: string } | undefined)?.sessionID
        if (sessionID) {
          pluginPromptedSessions.delete(sessionID)
          messageCache.delete(sessionID)
          handledRetrySessions.delete(sessionID)
          childSessions?.delete(sessionID)
          abortedChildren?.delete(sessionID)
        }
      }

      // Handle reactive fallback
      await handleReactiveEvent(event as unknown as Parameters<typeof handleReactiveEvent>[0], {
        client: client as unknown as Parameters<typeof handleReactiveEvent>[1]["client"],
        store,
        selector,
        rules: config.classification.rules,
        maxRetries: config.retryPolicy.maxRetries,
        logger,
        dedupSet,
        pluginPromptedSessions,
        messageCache,
        handledRetrySessions,
        childSessions,
        abortedChildren,
      })
     },

    "tool.execute.after": async (input: any, output: any) => {
      // P5: enhance task output with 429 context for aborted child sessions
      handleToolExecuteAfter(input, output, abortedChildren!, logger)
    },
    // Note: OpenCode Plugin API does not have a `cleanup` hook.
    // The tick timer uses `unref()` so it won't block process shutdown.
    // Timer is a small memory cost (one interval handle) — acceptable tradeoff.
    }
  },
}
