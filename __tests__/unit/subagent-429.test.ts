import { describe, it, expect, vi } from "vitest"
import { handleReactiveEvent } from "../../src/actions/reactive.js"
import { handleSessionCreated, handleToolExecuteAfter } from "../../src/index.js"
import { HealthStore } from "../../src/health/store.js"
import { ModelSelector } from "../../src/selection/selector.js"
import { createLogger } from "../../src/logging/logger.js"
import { BUILTIN_RULES } from "../../src/classification/patterns.js"
import type { Config } from "../../src/types.js"

function makeConfig(): Config {
  return {
    enabled: true,
    classification: { rules: BUILTIN_RULES },
    healthScore: {
      failurePenalty: 20,
      primary: { recoveryIntervalMs: 1_800_000, recoveryBonus: 10, successBehavior: "full" },
      fallback: { recoveryIntervalMs: 3_600_000, recoveryBonus: 5, successBonus: 5 },
    },
    retryPolicy: { maxRetries: 3 },
    agents: {
      build: { fallbackModels: ["deepseek/v4-pro"] },
    },
    primaryModels: new Set(["zhipuai/glm-5.1"]),
    logging: { level: "error", path: "" },
  }
}

describe("Subagent 429 recovery — child session abort-only", () => {
  it("child session: records failure + aborts without revert/prompt", async () => {
    const config = makeConfig()
    const store = new HealthStore(config)
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const abortFn = vi.fn().mockResolvedValue(undefined)
    const revertFn = vi.fn().mockResolvedValue(undefined)
    const promptFn = vi.fn().mockResolvedValue(undefined)
    const childSessions = new Set(["child-s1"])
    const abortedChildren = new Set<string>()

    const event = {
      type: "session.status",
      properties: {
        sessionID: "child-s1",
        status: { type: "retry", attempt: 4, message: "429 Rate Limited" },
      },
    }

    await handleReactiveEvent(event, {
      client: {
        session: {
          abort: abortFn,
          revert: revertFn,
          prompt: promptFn,
          messages: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      store, selector, rules: BUILTIN_RULES, maxRetries: 3,
      logger, dedupSet: new Set(), pluginPromptedSessions: new Set(),
      messageCache: new Map([["child-s1", [{ modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "m1" }]]]),
      handledRetrySessions: new Set(),
      childSessions,
      abortedChildren,
    })

    // Failure recorded (100 - 20 penalty = 80)
    expect(store.get("zhipuai/glm-5.1")).toBe(80)
    // Abort called
    expect(abortFn).toHaveBeenCalledOnce()
    expect(abortFn).toHaveBeenCalledWith({ path: { id: "child-s1" } })
    // Revert and prompt NOT called
    expect(revertFn).not.toHaveBeenCalled()
    expect(promptFn).not.toHaveBeenCalled()
    // AbortedChildren tracked
    expect(abortedChildren.has("child-s1")).toBe(true)
  })

  it("non-child session: existing reactive flow unchanged", async () => {
    const config = makeConfig()
    const store = new HealthStore(config)
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const abortFn = vi.fn().mockResolvedValue(undefined)
    const revertFn = vi.fn().mockResolvedValue(undefined)
    const promptFn = vi.fn().mockResolvedValue(undefined)
    const childSessions = new Set<string>() // empty — not a child session
    const abortedChildren = new Set<string>()

    const event = {
      type: "session.status",
      properties: {
        sessionID: "s1",
        status: { type: "retry", attempt: 4, message: "429 Rate Limited" },
      },
    }

    await handleReactiveEvent(event, {
      client: {
        session: {
          abort: abortFn,
          revert: revertFn,
          prompt: promptFn,
          messages: vi.fn().mockResolvedValue({ data: [{
            info: { id: "m1", role: "user" },
            parts: [{ type: "text", text: "test" }],
          }] }),
        },
      },
      store, selector, rules: BUILTIN_RULES, maxRetries: 3,
      logger, dedupSet: new Set(), pluginPromptedSessions: new Set(),
      messageCache: new Map([["s1", [{ modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "m1" }]]]),
      handledRetrySessions: new Set(),
      childSessions,
      abortedChildren,
    })

    // Normal flow: abort + revert + prompt all called
    expect(abortFn).toHaveBeenCalledOnce()
    expect(revertFn).toHaveBeenCalledOnce()
    expect(promptFn).toHaveBeenCalledOnce()
    // abortedChildren NOT populated for non-child
    expect(abortedChildren.size).toBe(0)
  })

  it("child session without cache: still aborts but no failure recorded", async () => {
    const config = makeConfig()
    const store = new HealthStore(config)
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const abortFn = vi.fn().mockResolvedValue(undefined)
    const childSessions = new Set(["child-s2"])
    const abortedChildren = new Set<string>()

    const event = {
      type: "session.status",
      properties: {
        sessionID: "child-s2",
        status: { type: "retry", attempt: 4, message: "429 Rate Limited" },
      },
    }

    await handleReactiveEvent(event, {
      client: {
        session: {
          abort: abortFn,
          revert: vi.fn(),
          prompt: vi.fn(),
          messages: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      store, selector, rules: BUILTIN_RULES, maxRetries: 3,
      logger, dedupSet: new Set(), pluginPromptedSessions: new Set(),
      messageCache: new Map(), // no cache entry for child-s2
      handledRetrySessions: new Set(),
      childSessions,
      abortedChildren,
    })

    // Abort still happens
    expect(abortFn).toHaveBeenCalledOnce()
    // Score unchanged (no cache entry to record failure)
    expect(store.get("zhipuai/glm-5.1")).toBe(100)
    // AbortedChildren still tracked
    expect(abortedChildren.has("child-s2")).toBe(true)
  })

  it("child session: abort-only path is taken before messages API call", async () => {
    // Verify the child branch short-circuits before the expensive messages API call
    const config = makeConfig()
    const store = new HealthStore(config)
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const abortFn = vi.fn().mockResolvedValue(undefined)
    const messagesFn = vi.fn().mockResolvedValue({ data: [] })
    const childSessions = new Set(["child-s3"])
    const abortedChildren = new Set<string>()

    const event = {
      type: "session.status",
      properties: {
        sessionID: "child-s3",
        status: { type: "retry", attempt: 4, message: "429 Rate Limited" },
      },
    }

    await handleReactiveEvent(event, {
      client: {
        session: {
          abort: abortFn,
          revert: vi.fn(),
          prompt: vi.fn(),
          messages: messagesFn,
        },
      },
      store, selector, rules: BUILTIN_RULES, maxRetries: 3,
      logger, dedupSet: new Set(), pluginPromptedSessions: new Set(),
      messageCache: new Map([["child-s3", [{ modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "m1" }]]]),
      handledRetrySessions: new Set(),
      childSessions,
      abortedChildren,
    })

    // messages() should NOT be called for child sessions (short-circuit before step ③)
    expect(messagesFn).not.toHaveBeenCalled()
    // But abort should be called
    expect(abortFn).toHaveBeenCalledOnce()
  })

  it("child session: handledRetrySessions flag stays set (anti-cascading)", async () => {
    const config = makeConfig()
    const store = new HealthStore(config)
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const abortFn = vi.fn().mockResolvedValue(undefined)
    const childSessions = new Set(["child-s4"])
    const abortedChildren = new Set<string>()
    const handledRetrySessions = new Set<string>()

    const event = {
      type: "session.status",
      properties: {
        sessionID: "child-s4",
        status: { type: "retry", attempt: 4, message: "429 Rate Limited" },
      },
    }

    await handleReactiveEvent(event, {
      client: {
        session: {
          abort: abortFn,
          revert: vi.fn(),
          prompt: vi.fn(),
          messages: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      store, selector, rules: BUILTIN_RULES, maxRetries: 3,
      logger, dedupSet: new Set(), pluginPromptedSessions: new Set(),
      messageCache: new Map([["child-s4", [{ modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "m1" }]]]),
      handledRetrySessions,
      childSessions,
      abortedChildren,
    })

    // The anti-cascading flag should remain set (abort is irreversible)
    expect(handledRetrySessions.has("child-s4")).toBe(true)
  })

  it("child session: second retry event is ignored (anti-cascading)", async () => {
    const config = makeConfig()
    const store = new HealthStore(config)
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const abortFn = vi.fn().mockResolvedValue(undefined)
    const childSessions = new Set(["child-s5"])
    const abortedChildren = new Set<string>()
    const handledRetrySessions = new Set<string>()

    const ctx = {
      client: {
        session: {
          abort: abortFn,
          revert: vi.fn(),
          prompt: vi.fn(),
          messages: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      store, selector, rules: BUILTIN_RULES, maxRetries: 3,
      logger, dedupSet: new Set(), pluginPromptedSessions: new Set(),
      messageCache: new Map([["child-s5", [{ modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "m1" }]]]),
      handledRetrySessions,
      childSessions,
      abortedChildren,
    }

    const event = {
      type: "session.status",
      properties: {
        sessionID: "child-s5",
        status: { type: "retry", attempt: 4, message: "429 Rate Limited" },
      },
    }

    // First event: should process normally
    await handleReactiveEvent(event, ctx)
    expect(abortFn).toHaveBeenCalledOnce()
    expect(store.get("zhipuai/glm-5.1")).toBe(80)

    // Reset score for second event test
    store._set("zhipuai/glm-5.1", { score: 80, lastRecoveryAt: 0 })

    // Second event with same sessionID: should be ignored (anti-cascading)
    await handleReactiveEvent(event, ctx)
    expect(abortFn).toHaveBeenCalledOnce() // still only 1 call
    expect(store.get("zhipuai/glm-5.1")).toBe(80) // score unchanged
  })

  it("child session: uses last cache entry for failure recording (not random one)", async () => {
    const config = makeConfig()
    const store = new HealthStore(config)
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })
    store._set("deepseek/v4-pro", { score: 100, lastRecoveryAt: 0 })
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const abortFn = vi.fn().mockResolvedValue(undefined)
    const childSessions = new Set(["child-s6"])
    const abortedChildren = new Set<string>()

    const event = {
      type: "session.status",
      properties: {
        sessionID: "child-s6",
        status: { type: "retry", attempt: 4, message: "429 Rate Limited" },
      },
    }

    // Cache has multiple entries — last one should be used
    await handleReactiveEvent(event, {
      client: {
        session: {
          abort: abortFn,
          revert: vi.fn(),
          prompt: vi.fn(),
          messages: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      store, selector, rules: BUILTIN_RULES, maxRetries: 3,
      logger, dedupSet: new Set(), pluginPromptedSessions: new Set(),
      messageCache: new Map([["child-s6", [
        { modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "m1" },
        { modelKey: "deepseek/v4-pro", agentName: "build", messageID: "m2" },
      ]]]),
      handledRetrySessions: new Set(),
      childSessions,
      abortedChildren,
    })

    // Last cache entry is deepseek/v4-pro — its score should drop
    expect(store.get("deepseek/v4-pro")).toBe(80)
    // First entry should be untouched
    expect(store.get("zhipuai/glm-5.1")).toBe(100)
  })

  it("child session: empty cache stack does not record failure", async () => {
    const config = makeConfig()
    const store = new HealthStore(config)
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const abortFn = vi.fn().mockResolvedValue(undefined)
    const childSessions = new Set(["child-s7"])
    const abortedChildren = new Set<string>()

    const event = {
      type: "session.status",
      properties: {
        sessionID: "child-s7",
        status: { type: "retry", attempt: 4, message: "429 Rate Limited" },
      },
    }

    // Cache exists but stack is empty
    await handleReactiveEvent(event, {
      client: {
        session: {
          abort: abortFn,
          revert: vi.fn(),
          prompt: vi.fn(),
          messages: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      store, selector, rules: BUILTIN_RULES, maxRetries: 3,
      logger, dedupSet: new Set(), pluginPromptedSessions: new Set(),
      messageCache: new Map([["child-s7", []]]), // empty array
      handledRetrySessions: new Set(),
      childSessions,
      abortedChildren,
    })

    // Abort still happens
    expect(abortFn).toHaveBeenCalledOnce()
    // Score unchanged (empty stack)
    expect(store.get("zhipuai/glm-5.1")).toBe(100)
    // Still tracked
    expect(abortedChildren.has("child-s7")).toBe(true)
  })

  it("child session: quota_exceeded → abort-only without excludeProvider processing", async () => {
    const config = makeConfig()
    // Setup: two models from same provider in fallback chain
    config.agents = {
      build: { fallbackModels: ["zhipuai/glm-5-turbo", "deepseek/v4-pro"] },
    }
    const store = new HealthStore(config)
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })
    store._set("zhipuai/glm-5-turbo", { score: 100, lastRecoveryAt: 0 })
    store._set("deepseek/v4-pro", { score: 100, lastRecoveryAt: 0 })
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const abortFn = vi.fn().mockResolvedValue(undefined)
    const childSessions = new Set(["child-quota"])
    const abortedChildren = new Set<string>()

    const event = {
      type: "session.status",
      properties: {
        sessionID: "child-quota",
        status: { type: "retry", attempt: 4, message: "免费账户的 API 调用次数已用尽" },
      },
    }

    await handleReactiveEvent(event, {
      client: {
        session: {
          abort: abortFn,
          revert: vi.fn(),
          prompt: vi.fn(),
          messages: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      store, selector, rules: BUILTIN_RULES, maxRetries: 3,
      logger, dedupSet: new Set(), pluginPromptedSessions: new Set(),
      messageCache: new Map([["child-quota", [{ modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "m1" }]]]),
      handledRetrySessions: new Set(),
      childSessions,
      abortedChildren,
    })

    // Child path: only abort, no model selection
    expect(abortFn).toHaveBeenCalledOnce()
    // Only the failed model's score drops (no excludeProvider cascade)
    expect(store.get("zhipuai/glm-5.1")).toBe(80)
    // Same-provider fallback model NOT affected (child path skips excludeProvider)
    expect(store.get("zhipuai/glm-5-turbo")).toBe(100)
    expect(store.get("deepseek/v4-pro")).toBe(100)
    // AbortedChildren tracked (abort succeeded)
    expect(abortedChildren.has("child-quota")).toBe(true)
  })
})

// ─── P3: session.created handler ──────────────────────────────────────────

describe("Subagent 429 recovery — session.created handler (P3)", () => {
  it("session.created with parentID → adds to childSessions", () => {
    const childSessions = new Set<string>()
    const logger = createLogger({ level: "error" })
    handleSessionCreated(
      { type: "session.created", properties: { sessionID: "child-1", info: { parentID: "parent-1" } } },
      childSessions,
      logger,
    )
    expect(childSessions.has("child-1")).toBe(true)
  })

  it("session.created without parentID → does not add to childSessions", () => {
    const childSessions = new Set<string>()
    const logger = createLogger({ level: "error" })
    handleSessionCreated(
      { type: "session.created", properties: { sessionID: "s1", info: {} } },
      childSessions,
      logger,
    )
    expect(childSessions.size).toBe(0)
  })

  it("non-session.created event → does not add to childSessions", () => {
    const childSessions = new Set<string>()
    const logger = createLogger({ level: "error" })
    handleSessionCreated(
      { type: "message.updated", properties: { sessionID: "s1" } },
      childSessions,
      logger,
    )
    expect(childSessions.size).toBe(0)
  })
})

// ─── P5: tool.execute.after handler ───────────────────────────────────────

describe("Subagent 429 recovery — tool.execute.after hook (P5)", () => {
  it("task+aborted child → enhances output with session ID and export instructions", () => {
    const abortedChildren = new Set(["child-1"])
    const logger = createLogger({ level: "error" })
    const output: { output: string; metadata: Record<string, unknown> } = {
      output: "task completed with result",
      metadata: { sessionId: "child-1", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
    }
    handleToolExecuteAfter(
      { tool: "task", sessionID: "parent-1" },
      output,
      abortedChildren,
      logger,
    )
    expect(output.output).toContain("child-1")
    expect(output.output).toContain("zhipuai/glm-5.1")
    expect(output.output).toContain("opencode export child-1")
    expect(abortedChildren.has("child-1")).toBe(false) // consumed
  })

  it("task+non-aborted child → skips without modifying output", () => {
    const abortedChildren = new Set<string>() // empty
    const logger = createLogger({ level: "error" })
    const output: { output: string; metadata: Record<string, unknown> } = {
      output: "original output",
      metadata: { sessionId: "child-2" },
    }
    handleToolExecuteAfter(
      { tool: "task", sessionID: "parent-1" },
      output,
      abortedChildren,
      logger,
    )
    expect(output.output).toBe("original output") // unchanged
  })

  it("non-task tool → skips", () => {
    const abortedChildren = new Set(["child-1"])
    const logger = createLogger({ level: "error" })
    const output: { output: string; metadata: Record<string, unknown> } = {
      output: "original",
      metadata: {},
    }
    handleToolExecuteAfter(
      { tool: "read", sessionID: "parent-1" },
      output,
      abortedChildren,
      logger,
    )
    expect(output.output).toBe("original") // unchanged
    expect(abortedChildren.has("child-1")).toBe(true) // not consumed
  })

  it("task without sessionId in metadata → skips", () => {
    const abortedChildren = new Set(["child-1"])
    const logger = createLogger({ level: "error" })
    const output: { output: string; metadata: Record<string, unknown> } = {
      output: "original",
      metadata: {},
    }
    handleToolExecuteAfter(
      { tool: "task", sessionID: "parent-1" },
      output,
      abortedChildren,
      logger,
    )
    expect(output.output).toBe("original")
    expect(abortedChildren.has("child-1")).toBe(true) // not consumed
  })

  it("task with model fallback → shows '模型' when no model info", () => {
    const abortedChildren = new Set(["child-3"])
    const logger = createLogger({ level: "error" })
    const output: { output: string; metadata: Record<string, unknown> } = {
      output: "some result",
      metadata: { sessionId: "child-3" },
    }
    handleToolExecuteAfter(
      { tool: "task", sessionID: "parent-1" },
      output,
      abortedChildren,
      logger,
    )
    expect(output.output).toContain("模型 429 限流中断")
    expect(abortedChildren.has("child-3")).toBe(false) // consumed
  })
})

// ─── P6: child abort error handling ───────────────────────────────────────

describe("Subagent 429 recovery — child abort error handling", () => {
  it("child session: abort() throws → logs error, cleans up handledRetrySessions", async () => {
    const config = makeConfig()
    const store = new HealthStore(config)
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const abortFn = vi.fn().mockRejectedValue(new Error("session already ended"))
    const revertFn = vi.fn().mockResolvedValue(undefined)
    const promptFn = vi.fn().mockResolvedValue(undefined)
    const childSessions = new Set(["child-abort-err"])
    const abortedChildren = new Set<string>()
    const handledRetrySessions = new Set<string>()

    const event = {
      type: "session.status",
      properties: {
        sessionID: "child-abort-err",
        status: { type: "retry", attempt: 4, message: "429 Rate Limited" },
      },
    }

    // Should NOT throw despite abort() rejection — try/catch absorbs it
    await handleReactiveEvent(event, {
      client: {
        session: {
          abort: abortFn,
          revert: revertFn,
          prompt: promptFn,
          messages: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      store, selector, rules: BUILTIN_RULES, maxRetries: 3,
      logger, dedupSet: new Set(), pluginPromptedSessions: new Set(),
      messageCache: new Map([["child-abort-err", [{ modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "m1" }]]]),
      handledRetrySessions,
      childSessions,
      abortedChildren,
    })

    // abort was attempted
    expect(abortFn).toHaveBeenCalledOnce()
    expect(abortFn).toHaveBeenCalledWith({ path: { id: "child-abort-err" } })
    // revert and prompt NOT called (child branch)
    expect(revertFn).not.toHaveBeenCalled()
    expect(promptFn).not.toHaveBeenCalled()
    // abortedChildren should NOT contain the sessionID (abort failed — no phantom entry)
    expect(abortedChildren.has("child-abort-err")).toBe(false)
    // Failure was still recorded (score penalty applied before abort attempt)
    expect(store.get("zhipuai/glm-5.1")).toBe(80)
    // Anti-cascading flag cleaned up so future retry events can be processed
    expect(handledRetrySessions.has("child-abort-err")).toBe(false)
  })

  it("child session: abort fails → retry event processed on second attempt", async () => {
    const config = makeConfig()
    const store = new HealthStore(config)
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const childSessions = new Set(["child-retry"])
    const abortedChildren = new Set<string>()
    const handledRetrySessions = new Set<string>()

    const ctx = {
      client: {
        session: {
          // First call fails, second succeeds
          abort: vi.fn()
            .mockRejectedValueOnce(new Error("connection reset"))
            .mockResolvedValueOnce(undefined),
          revert: vi.fn().mockResolvedValue(undefined),
          prompt: vi.fn().mockResolvedValue(undefined),
          messages: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      store, selector, rules: BUILTIN_RULES, maxRetries: 3,
      logger, dedupSet: new Set(), pluginPromptedSessions: new Set(),
      messageCache: new Map([["child-retry", [{ modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "m1" }]]]),
      handledRetrySessions,
      childSessions,
      abortedChildren,
    }

    const event = {
      type: "session.status",
      properties: {
        sessionID: "child-retry",
        status: { type: "retry", attempt: 4, message: "429 Rate Limited" },
      },
    }

    // First attempt: abort fails → handledRetrySessions cleaned
    await handleReactiveEvent(event, ctx)
    expect(ctx.client.session.abort).toHaveBeenCalledOnce()
    expect(abortedChildren.has("child-retry")).toBe(false)
    expect(handledRetrySessions.has("child-retry")).toBe(false)
    // Score drops once: 100 → 80
    expect(store.get("zhipuai/glm-5.1")).toBe(80)

    // Reset score to test second attempt records another failure
    store._set("zhipuai/glm-5.1", { score: 80, lastRecoveryAt: 0 })

    // Second attempt: abort succeeds → full child path works
    await handleReactiveEvent(event, ctx)
    expect(ctx.client.session.abort).toHaveBeenCalledTimes(2)
    expect(abortedChildren.has("child-retry")).toBe(true)
    expect(store.get("zhipuai/glm-5.1")).toBe(60) // 80 - 20 = 60
  })
})

// ─── P7: child cache consumption ─────────────────────────────────────────

describe("Subagent 429 recovery — child cache consumption on abort", () => {
  it("child abort success → messageCache entry consumed (popped)", async () => {
    const config = makeConfig()
    const store = new HealthStore(config)
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const messageCache = new Map([
      ["child-cache-1", [{ modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "m1" }]],
    ])

    await handleReactiveEvent(
      {
        type: "session.status",
        properties: {
          sessionID: "child-cache-1",
          status: { type: "retry", attempt: 4, message: "429 Rate Limited" },
        },
      },
      {
        client: {
          session: {
            abort: vi.fn().mockResolvedValue(undefined),
            revert: vi.fn().mockResolvedValue(undefined),
            prompt: vi.fn().mockResolvedValue(undefined),
            messages: vi.fn().mockResolvedValue({ data: [] }),
          },
        },
        store, selector, rules: BUILTIN_RULES, maxRetries: 3,
        logger, dedupSet: new Set(), pluginPromptedSessions: new Set(),
        messageCache,
        handledRetrySessions: new Set(),
        childSessions: new Set(["child-cache-1"]),
        abortedChildren: new Set(),
      },
    )

    // Cache entry should be fully removed (stack became empty after pop)
    expect(messageCache.has("child-cache-1")).toBe(false)
  })

  it("child abort success → multi-entry stack: only last entry consumed", async () => {
    const config = makeConfig()
    const store = new HealthStore(config)
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const messageCache = new Map([
      ["child-cache-multi", [
        { modelKey: "deepseek/v4-pro", agentName: "build", messageID: "m-early" },
        { modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "m-last" },
      ]],
    ])

    await handleReactiveEvent(
      {
        type: "session.status",
        properties: {
          sessionID: "child-cache-multi",
          status: { type: "retry", attempt: 4, message: "429 Rate Limited" },
        },
      },
      {
        client: {
          session: {
            abort: vi.fn().mockResolvedValue(undefined),
            revert: vi.fn().mockResolvedValue(undefined),
            prompt: vi.fn().mockResolvedValue(undefined),
            messages: vi.fn().mockResolvedValue({ data: [] }),
          },
        },
        store, selector, rules: BUILTIN_RULES, maxRetries: 3,
        logger, dedupSet: new Set(), pluginPromptedSessions: new Set(),
        messageCache,
        handledRetrySessions: new Set(),
        childSessions: new Set(["child-cache-multi"]),
        abortedChildren: new Set(),
      },
    )

    // Last entry consumed, first entry remains
    expect(messageCache.has("child-cache-multi")).toBe(true)
    const remaining = messageCache.get("child-cache-multi")!
    expect(remaining.length).toBe(1)
    expect(remaining[0].modelKey).toBe("deepseek/v4-pro")
    // Failure recorded on the LAST entry's model
    expect(store.get("zhipuai/glm-5.1")).toBe(80)
  })

  it("child abort failure → messageCache entry preserved for retry", async () => {
    const config = makeConfig()
    const store = new HealthStore(config)
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const messageCache = new Map([
      ["child-cache-fail", [{ modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "m1" }]],
    ])

    await handleReactiveEvent(
      {
        type: "session.status",
        properties: {
          sessionID: "child-cache-fail",
          status: { type: "retry", attempt: 4, message: "429 Rate Limited" },
        },
      },
      {
        client: {
          session: {
            abort: vi.fn().mockRejectedValue(new Error("connection reset")),
            revert: vi.fn().mockResolvedValue(undefined),
            prompt: vi.fn().mockResolvedValue(undefined),
            messages: vi.fn().mockResolvedValue({ data: [] }),
          },
        },
        store, selector, rules: BUILTIN_RULES, maxRetries: 3,
        logger, dedupSet: new Set(), pluginPromptedSessions: new Set(),
        messageCache,
        handledRetrySessions: new Set(),
        childSessions: new Set(["child-cache-fail"]),
        abortedChildren: new Set(),
      },
    )

    // Cache entry should NOT be consumed — preserved for potential retry
    expect(messageCache.has("child-cache-fail")).toBe(true)
    const remaining = messageCache.get("child-cache-fail")!
    expect(remaining.length).toBe(1)
    expect(remaining[0].modelKey).toBe("zhipuai/glm-5.1")
  })
})

// ─── P8: tool.execute.after edge cases ─────────────────────────────────────

describe("Subagent 429 recovery — tool.execute.after edge cases", () => {
  it("task+aborted child with non-string output → converts to string", () => {
    const abortedChildren = new Set(["child-ns"])
    const logger = createLogger({ level: "error" })
    const output: { output: unknown; metadata: Record<string, unknown> } = {
      output: { some: "object" },
      metadata: { sessionId: "child-ns", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
    }
    handleToolExecuteAfter(
      { tool: "task", sessionID: "parent-1" },
      output,
      abortedChildren,
      logger,
    )
    // String({ some: "object" }) = "[object Object]"
    const result = output.output as string
    expect(result).toContain("[object Object]")
    expect(result).toContain("child-ns")
    expect(result).toContain("zhipuai/glm-5.1")
    expect(result).toContain("429")
    expect(abortedChildren.has("child-ns")).toBe(false) // consumed
  })

  it("task+aborted child with null output → uses empty string", () => {
    const abortedChildren = new Set(["child-null"])
    const logger = createLogger({ level: "error" })
    const output: { output: unknown; metadata: Record<string, unknown> } = {
      output: null,
      metadata: { sessionId: "child-null", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
    }
    handleToolExecuteAfter(
      { tool: "task", sessionID: "parent-1" },
      output,
      abortedChildren,
      logger,
    )
    // String(null || "") = "" → output starts with separator line
    const result = output.output as string
    expect(result).toContain("---")
    expect(result).toContain("child-null")
    expect(result).toContain("429")
    expect(abortedChildren.has("child-null")).toBe(false) // consumed
  })

  it("task+aborted child with undefined metadata → skips", () => {
    const abortedChildren = new Set(["child-undef"])
    const logger = createLogger({ level: "error" })
    const output: { output: string; metadata: unknown } = {
      output: "original output",
      metadata: undefined,
    }
    handleToolExecuteAfter(
      { tool: "task", sessionID: "parent-1" },
      output,
      abortedChildren,
      logger,
    )
    // metadata is undefined → sessionId lookup fails → skips entirely
    expect(output.output).toBe("original output")
    expect(abortedChildren.has("child-undef")).toBe(true) // not consumed
  })
})
