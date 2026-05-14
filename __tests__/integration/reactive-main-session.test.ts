import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * Integration Tests: Main Session Reactive Path (abort + revert + prompt)
 *
 * Tests the full reactive chain for main (non-child) sessions, covering:
 * - abort + revert + prompt with fallback model selection
 * - Classification categories (429, 5xx, timeout, quota_exceeded)
 * - Edge cases: chain_exhausted, same_model, API failures, dedup, headless
 * - HealthStore lifecycle: recordSuccess, tick recovery, cleanup
 */

import { HealthStore } from "../../src/health/store.js"
import { ModelSelector } from "../../src/selection/selector.js"
import { handleReactiveEvent, cleanupDedupForSession, cleanupDedupBySize } from "../../src/actions/reactive.js"
import { handleChatMessage } from "../../src/actions/preemptive.js"
import { BUILTIN_RULES } from "../../src/classification/patterns.js"
import { createLogger } from "../../src/logging/logger.js"
import type { Config } from "../../src/types.js"

// ─── Shared config factory (same as subagent-429-chain.test.ts) ──────────

function makeE2EConfig(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    classification: { rules: BUILTIN_RULES },
    healthScore: {
      failurePenalty: 20,
      primary: { recoveryIntervalMs: 60_000, recoveryBonus: 10, successBehavior: "full" },
      fallback: { recoveryIntervalMs: 120_000, recoveryBonus: 5, successBonus: 5 },
    },
    retryPolicy: { maxRetries: 3 },
    agents: {
      build: { fallbackModels: ["deepseek/v4-pro", "deepseek/v4-flash"] },
      "*": { fallbackModels: ["deepseek/v4-flash"] },
    },
    primaryModels: new Set(["zhipuai/glm-5.1", "zhipuai/glm-5-turbo"]),
    agentModels: {},
    logging: { level: "debug", path: "" },
    ...overrides,
  }
}

// ─── Plugin context (real components) ────────────────────────────────────

interface PluginContext {
  config: Config
  store: HealthStore
  selector: ModelSelector
  dedupSet: Set<string>
  pluginPromptedSessions: Set<string>
  handledRetrySessions: Set<string>
  messageCache: Map<string, Array<{ modelKey: string; agentName: string; messageID: string }>>
  childSessions: Set<string>
  abortedChildren: Set<string>
  logger: ReturnType<typeof createLogger>
}

function createPluginContext(config?: Config): PluginContext {
  const cfg = config ?? makeE2EConfig()
  const store = new HealthStore(cfg)
  const selector = new ModelSelector(cfg, store)
  const dedupSet = new Set<string>()
  const pluginPromptedSessions = new Set<string>()
  const handledRetrySessions = new Set<string>()
  const messageCache = new Map<string, Array<{ modelKey: string; agentName: string; messageID: string }>>()
  const childSessions = new Set<string>()
  const abortedChildren = new Set<string>()
  const logger = createLogger({ level: "debug" })
  return {
    config: cfg, store, selector, dedupSet, pluginPromptedSessions,
    handledRetrySessions, messageCache, childSessions, abortedChildren, logger,
  }
}

// ─── Mock client factory ─────────────────────────────────────────────────

function mockClient(overrides?: {
  messagesReturnValue?: unknown
  revertFn?: ReturnType<typeof vi.fn>
  promptFn?: ReturnType<typeof vi.fn>
}) {
  return {
    session: {
      abort: vi.fn().mockResolvedValue(undefined),
      revert: overrides?.revertFn ?? vi.fn().mockResolvedValue(undefined),
      prompt: overrides?.promptFn ?? vi.fn().mockResolvedValue({ info: { id: "msg-reply" }, parts: [] }),
      messages: vi.fn().mockResolvedValue(
        overrides?.messagesReturnValue ?? {
          data: [{
            info: {
              id: "msg-1",
              role: "user",
              model: { providerID: "zhipuai", modelID: "glm-5.1" },
              agent: "build",
            },
            parts: [{ type: "text", text: "test message" }],
          }],
        },
      ),
    },
    tui: { showToast: vi.fn().mockResolvedValue(true) },
  }
}

// ─── Helper: fire a reactive event ───────────────────────────────────────

async function fireReactive(
  ctx: PluginContext,
  client: ReturnType<typeof mockClient>,
  sessionID: string,
  attempt: number,
  message: string,
) {
  await handleReactiveEvent(
    {
      type: "session.status",
      properties: {
        sessionID,
        status: { type: "retry", attempt, message },
      },
    },
    {
      client: client as any,
      store: ctx.store,
      selector: ctx.selector,
      rules: ctx.config.classification.rules,
      maxRetries: ctx.config.retryPolicy.maxRetries,
      logger: ctx.logger,
      dedupSet: ctx.dedupSet,
      pluginPromptedSessions: ctx.pluginPromptedSessions,
      messageCache: ctx.messageCache,
      handledRetrySessions: ctx.handledRetrySessions,
      childSessions: ctx.childSessions,
      abortedChildren: ctx.abortedChildren,
    },
  )
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("Integration: Main session reactive path (abort + revert + prompt)", () => {

  // ─── Test 1 ────────────────────────────────────────────────────────────

  it("main session 429 → full reactive chain: abort + revert + prompt with fallback model", async () => {
    const ctx = createPluginContext()
    const client = mockClient()

    // Cache a message for the main session (NOT a child session)
    ctx.messageCache.set("main-s1", [{
      modelKey: "zhipuai/glm-5.1",
      agentName: "build",
      messageID: "msg-1",
    }])

    // Fire retry event (attempt=4 > maxRetries=3)
    await fireReactive(ctx, client, "main-s1", 4, "429 Rate Limited")

    // Verify: full reactive chain executed
    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: "main-s1" } })
    expect(client.session.abort).toHaveBeenCalledOnce()

    expect(client.session.revert).toHaveBeenCalledWith({
      path: { id: "main-s1" },
      body: { messageID: "msg-1" },
    })
    expect(client.session.revert).toHaveBeenCalledOnce()

    // prompt should use the best fallback model: deepseek/v4-pro (score 100 > zhipuai/glm-5.1 at 80)
    expect(client.session.prompt).toHaveBeenCalledWith({
      path: { id: "main-s1" },
      body: {
        model: { providerID: "deepseek", modelID: "v4-pro" },
        parts: [{ type: "text", text: "test message" }],
      },
    })
    expect(client.session.prompt).toHaveBeenCalledOnce()

    // Health score for zhipuai/glm-5.1 dropped to 80
    expect(ctx.store.get("zhipuai/glm-5.1")).toBe(80)

    // pluginPromptedSessions tracks the session
    expect(ctx.pluginPromptedSessions.has("main-s1")).toBe(true)
  })

  // ─── Test 2 ────────────────────────────────────────────────────────────

  it("main session 500 → 5xx classification → abort + revert + prompt", async () => {
    const ctx = createPluginContext()
    const client = mockClient()

    ctx.messageCache.set("main-s2", [{
      modelKey: "zhipuai/glm-5.1",
      agentName: "build",
      messageID: "msg-1",
    }])

    await fireReactive(ctx, client, "main-s2", 4, "500 Internal Server Error")

    // Same reactive chain fires
    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: "main-s2" } })
    expect(client.session.revert).toHaveBeenCalledWith({
      path: { id: "main-s2" },
      body: { messageID: "msg-1" },
    })
    expect(client.session.prompt).toHaveBeenCalled()
    expect(client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "deepseek", modelID: "v4-pro" },
        }),
      }),
    )

    // Health score dropped to 80
    expect(ctx.store.get("zhipuai/glm-5.1")).toBe(80)
  })

  // ─── Test 3 ────────────────────────────────────────────────────────────

  it("main session timeout → timeout classification → abort + revert + prompt", async () => {
    const ctx = createPluginContext()
    const client = mockClient()

    ctx.messageCache.set("main-s3", [{
      modelKey: "zhipuai/glm-5.1",
      agentName: "build",
      messageID: "msg-1",
    }])

    // "request timed out after 30s" contains "timed out" → matches timeout classification
    await fireReactive(ctx, client, "main-s3", 4, "request timed out after 30s")

    // Same reactive chain fires
    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: "main-s3" } })
    expect(client.session.revert).toHaveBeenCalledWith({
      path: { id: "main-s3" },
      body: { messageID: "msg-1" },
    })
    expect(client.session.prompt).toHaveBeenCalled()

    // Health score dropped
    expect(ctx.store.get("zhipuai/glm-5.1")).toBe(80)
  })

  // ─── Test 4 ────────────────────────────────────────────────────────────

  it("quota_exceeded → excludeProvider filters all same-provider models", async () => {
    const ctx = createPluginContext(makeE2EConfig({
      agents: {
        build: { fallbackModels: ["zhipuai/glm-5-turbo", "deepseek/v4-pro"] },
        "*": { fallbackModels: ["deepseek/v4-flash"] },
      },
    }))
    const client = mockClient()

    ctx.messageCache.set("main-s4", [{
      modelKey: "zhipuai/glm-5.1",
      agentName: "build",
      messageID: "msg-1",
    }])

    // "免费账户的 API 调用次数已用尽" contains "已用尽" → quota_exceeded classification
    await fireReactive(ctx, client, "main-s4", 4, "免费账户的 API 调用次数已用尽")

    // prompt should use deepseek/v4-pro (zhipuai models excluded by excludeProvider)
    expect(client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "deepseek", modelID: "v4-pro" },
        }),
      }),
    )
    expect(client.session.abort).toHaveBeenCalled()
    expect(client.session.revert).toHaveBeenCalled()
  })

  // ─── Test 5 ────────────────────────────────────────────────────────────

  it("chain_exhausted → toast notification, no crash", async () => {
    const ctx = createPluginContext(makeE2EConfig({
      agents: {
        build: { fallbackModels: [] },
        "*": { fallbackModels: [] },
      },
    }))
    const client = mockClient()

    ctx.messageCache.set("main-s5", [{
      modelKey: "zhipuai/glm-5.1",
      agentName: "build",
      messageID: "msg-1",
    }])

    await fireReactive(ctx, client, "main-s5", 4, "429 Rate Limited")

    // showToast called with error variant
    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: { message: "所有 fallback 模型已耗尽", variant: "error" },
    })

    // No abort/revert/prompt called
    expect(client.session.abort).not.toHaveBeenCalled()
    expect(client.session.revert).not.toHaveBeenCalled()
    expect(client.session.prompt).not.toHaveBeenCalled()
  })

  // ─── Test 6 ────────────────────────────────────────────────────────────

  it("same_model → toast warning, no prompt", async () => {
    const ctx = createPluginContext(makeE2EConfig({
      agents: {
        build: { fallbackModels: ["zhipuai/glm-5.1"] },
        "*": { fallbackModels: ["zhipuai/glm-5.1"] },
      },
    }))
    const client = mockClient()

    ctx.messageCache.set("main-s6", [{
      modelKey: "zhipuai/glm-5.1",
      agentName: "build",
      messageID: "msg-1",
    }])

    await fireReactive(ctx, client, "main-s6", 4, "429 Rate Limited")

    // showToast called with warning variant
    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: { message: "zhipuai/glm-5.1 无其他可用 fallback", variant: "warning" },
    })

    // No abort/revert/prompt called
    expect(client.session.abort).not.toHaveBeenCalled()
    expect(client.session.revert).not.toHaveBeenCalled()
    expect(client.session.prompt).not.toHaveBeenCalled()
  })

  // ─── Test 7 ────────────────────────────────────────────────────────────

  it("messages() API failure → graceful exit, handledRetrySessions cleaned", async () => {
    const ctx = createPluginContext()
    const client = mockClient()
    // Override messages to reject
    client.session.messages = vi.fn().mockRejectedValue(new Error("network error"))

    ctx.messageCache.set("main-s7", [{
      modelKey: "zhipuai/glm-5.1",
      agentName: "build",
      messageID: "msg-1",
    }])

    await fireReactive(ctx, client, "main-s7", 4, "429 Rate Limited")

    // handledRetrySessions should NOT contain the sessionID (cleaned up)
    expect(ctx.handledRetrySessions.has("main-s7")).toBe(false)

    // No abort/revert/prompt called
    expect(client.session.abort).not.toHaveBeenCalled()
    expect(client.session.revert).not.toHaveBeenCalled()
    expect(client.session.prompt).not.toHaveBeenCalled()
  })

  // ─── Test 8 ────────────────────────────────────────────────────────────

  it("revert failure → continues to prompt (non-blocking)", async () => {
    const ctx = createPluginContext()
    const revertFn = vi.fn().mockRejectedValue(new Error("revert failed"))
    const client = mockClient({ revertFn })

    ctx.messageCache.set("main-s8", [{
      modelKey: "zhipuai/glm-5.1",
      agentName: "build",
      messageID: "msg-1",
    }])

    await fireReactive(ctx, client, "main-s8", 4, "429 Rate Limited")

    // revert was called but failed
    expect(client.session.revert).toHaveBeenCalled()

    // prompt STILL called despite revert failure
    expect(client.session.prompt).toHaveBeenCalled()
    expect(client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "deepseek", modelID: "v4-pro" },
        }),
      }),
    )

    // abort was called
    expect(client.session.abort).toHaveBeenCalled()
  })

  // ─── Test 9 ────────────────────────────────────────────────────────────

  it("prompt failure → cleans both flags", async () => {
    const ctx = createPluginContext()
    const promptFn = vi.fn().mockRejectedValue(new Error("prompt failed"))
    const client = mockClient({ promptFn })

    ctx.messageCache.set("main-s9", [{
      modelKey: "zhipuai/glm-5.1",
      agentName: "build",
      messageID: "msg-1",
    }])

    await fireReactive(ctx, client, "main-s9", 4, "429 Rate Limited")

    // pluginPromptedSessions does NOT contain sessionID (cleaned on prompt failure)
    expect(ctx.pluginPromptedSessions.has("main-s9")).toBe(false)

    // handledRetrySessions does NOT contain sessionID (cleaned on prompt failure)
    expect(ctx.handledRetrySessions.has("main-s9")).toBe(false)
  })

  // ─── Test 10 ───────────────────────────────────────────────────────────

  it("dedup: same session+messageID+attempt → second event ignored", async () => {
    const ctx = createPluginContext()
    const client = mockClient()

    ctx.messageCache.set("main-s10", [{
      modelKey: "zhipuai/glm-5.1",
      agentName: "build",
      messageID: "msg-1",
    }])

    // First call: handledRetrySessions is empty, will proceed
    // We need a separate cache entry for the second call since the first one gets spliced
    // But actually, handledRetrySessions blocks the second call before cache lookup
    // So we just fire twice with same params — second will be blocked by handledRetrySessions
    await fireReactive(ctx, client, "main-s10", 4, "429 Rate Limited")

    // Re-add the cache entry (first call consumed it)
    ctx.messageCache.set("main-s10", [{
      modelKey: "zhipuai/glm-5.1",
      agentName: "build",
      messageID: "msg-1",
    }])

    // Second call: handledRetrySessions already contains "main-s10"
    await fireReactive(ctx, client, "main-s10", 4, "429 Rate Limited")

    // abort only called once
    expect(client.session.abort).toHaveBeenCalledOnce()
    expect(client.session.revert).toHaveBeenCalledOnce()
    expect(client.session.prompt).toHaveBeenCalledOnce()
  })

  // ─── Test 11 ───────────────────────────────────────────────────────────

  it("headless mode: cache entry with empty messageID → fallback match", async () => {
    const ctx = createPluginContext()
    // Mock messages() to return a user message with id "actual-msg-id"
    const client = mockClient({
      messagesReturnValue: {
        data: [{
          info: {
            id: "actual-msg-id",
            role: "user",
            model: { providerID: "zhipuai", modelID: "glm-5.1" },
            agent: "build",
          },
          parts: [{ type: "text", text: "headless message" }],
        }],
      },
    })

    // Cache entry with empty messageID (headless mode)
    ctx.messageCache.set("main-s11", [{
      modelKey: "zhipuai/glm-5.1",
      agentName: "build",
      messageID: "",  // headless marker
    }])

    await fireReactive(ctx, client, "main-s11", 4, "429 Rate Limited")

    // Reactive still works using the fallback match on last cache entry
    expect(client.session.abort).toHaveBeenCalled()
    expect(client.session.revert).toHaveBeenCalledWith({
      path: { id: "main-s11" },
      body: { messageID: "" },  // userMessageID is the cached entry's messageID (empty)
    })
    expect(client.session.prompt).toHaveBeenCalled()
    expect(ctx.store.get("zhipuai/glm-5.1")).toBe(80)
  })

  // ─── Test 12 ───────────────────────────────────────────────────────────

  it("recordSuccess: primary model → full reset to 100", () => {
    const ctx = createPluginContext()

    // Record failure: score becomes 80
    ctx.store.recordFailure("zhipuai/glm-5.1")
    expect(ctx.store.get("zhipuai/glm-5.1")).toBe(80)

    // Record success on primary model: full reset to 100
    ctx.store.recordSuccess("zhipuai/glm-5.1")
    expect(ctx.store.get("zhipuai/glm-5.1")).toBe(100)
  })

  // ─── Test 13 ───────────────────────────────────────────────────────────

  it("recordSuccess: fallback model → bonus increment", () => {
    const ctx = createPluginContext()

    // Manually set fallback model score to 70
    ctx.store._set("deepseek/v4-pro", { score: 70, lastRecoveryAt: Date.now() })

    // Record success on fallback model: 70 + 5 (successBonus) = 75
    ctx.store.recordSuccess("deepseek/v4-pro")
    expect(ctx.store.get("deepseek/v4-pro")).toBe(75)
  })

  // ─── Test 14 ───────────────────────────────────────────────────────────

  it("HealthStore.tick(): score recovers over time", () => {
    const ctx = createPluginContext()

    // Set score to 60 with lastRecoveryAt 61 seconds ago (past primary recoveryIntervalMs of 60s)
    ctx.store._set("zhipuai/glm-5.1", { score: 60, lastRecoveryAt: Date.now() - 61_000 })

    ctx.store.tick()

    // Score recovers: 60 + 10 (primary recoveryBonus) = 70
    expect(ctx.store.get("zhipuai/glm-5.1")).toBe(70)

    // lastRecoveryAt should be updated
    const entry = (ctx.store as any).store.get("zhipuai/glm-5.1")
    expect(entry.lastRecoveryAt).toBeGreaterThan(Date.now() - 61_000)
  })

  // ─── Test 15 ───────────────────────────────────────────────────────────

  it("HealthStore.tick(): no recovery before interval", () => {
    const ctx = createPluginContext()

    // Set score to 60 with lastRecoveryAt 30 seconds ago (NOT past 60s interval)
    ctx.store._set("zhipuai/glm-5.1", { score: 60, lastRecoveryAt: Date.now() - 30_000 })

    ctx.store.tick()

    // Score should still be 60
    expect(ctx.store.get("zhipuai/glm-5.1")).toBe(60)
  })

  // ─── Test 16 ───────────────────────────────────────────────────────────

  it("cleanupDedupForSession removes all keys for a session", () => {
    const dedupSet = new Set(["s1:msg1:1", "s1:msg1:2", "s2:msg1:1"])

    cleanupDedupForSession(dedupSet, "s1")

    // Only "s2:msg1:1" remains
    expect(dedupSet.size).toBe(1)
    expect(dedupSet.has("s2:msg1:1")).toBe(true)
    expect(dedupSet.has("s1:msg1:1")).toBe(false)
    expect(dedupSet.has("s1:msg1:2")).toBe(false)
  })

  // ─── Test 17 ───────────────────────────────────────────────────────────

  it("cleanupDedupBySize: clears 50% when over 10000", () => {
    const dedupSet = new Set<string>()

    // Add 10001 entries
    for (let i = 0; i < 10001; i++) {
      dedupSet.add(`session-${i}:msg-1:1`)
    }
    expect(dedupSet.size).toBe(10001)

    cleanupDedupBySize(dedupSet)

    // Cleared ~5000 entries: ceil(10001 * 0.5) = 5001 deleted → 10001 - 5001 = 5000
    expect(dedupSet.size).toBe(5000)
  })

  // ─── Test 18 ───────────────────────────────────────────────────────────

  it("preemptive: no switch when current model is already highest score", () => {
    const ctx = createPluginContext()

    // Initialize fallback models to score 100 (same as default)
    ctx.store._set("deepseek/v4-pro", { score: 100, lastRecoveryAt: 0 })
    ctx.store._set("deepseek/v4-flash", { score: 100, lastRecoveryAt: 0 })

    // All models at score 100 — current model zhipuai/glm-5.1 is primary at 100
    expect(ctx.store.get("zhipuai/glm-5.1")).toBe(100)
    expect(ctx.store.get("deepseek/v4-pro")).toBe(100)
    expect(ctx.store.get("deepseek/v4-flash")).toBe(100)

    const output = {
      message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } },
      parts: [],
    }

    handleChatMessage(
      { sessionID: "preempt-s1", agent: "build", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
      output,
      ctx.store,
      ctx.config,
      ctx.logger,
    )

    // Model unchanged — already highest score and primary position wins tie-break
    expect(output.message.model).toEqual({ providerID: "zhipuai", modelID: "glm-5.1" })
  })

  // ─── Test 19 ───────────────────────────────────────────────────────────

  it("main session: abort failure → handledRetrySessions cleaned, no revert/prompt", async () => {
    const ctx = createPluginContext()
    const client = mockClient()
    // Override abort to reject
    client.session.abort = vi.fn().mockRejectedValue(new Error("session already closed"))

    ctx.messageCache.set("main-s19", [{
      modelKey: "zhipuai/glm-5.1",
      agentName: "build",
      messageID: "msg-1",
    }])

    await fireReactive(ctx, client, "main-s19", 4, "429 Rate Limited")

    // abort was attempted
    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: "main-s19" } })
    expect(client.session.abort).toHaveBeenCalledOnce()

    // revert and prompt NOT called (abort failed before reaching them)
    expect(client.session.revert).not.toHaveBeenCalled()
    expect(client.session.prompt).not.toHaveBeenCalled()

    // handledRetrySessions cleaned — allows future retry events to reattempt
    expect(ctx.handledRetrySessions.has("main-s19")).toBe(false)

    // Health score still dropped (recordFailure runs before abort)
    expect(ctx.store.get("zhipuai/glm-5.1")).toBe(80)
  })
})
