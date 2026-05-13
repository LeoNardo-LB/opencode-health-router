import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * E2E Tests: Subagent 429 Recovery — Full Chain
 *
 * These tests simulate the full chain of subagent 429 recovery using real
 * plugin components (HealthStore, ModelSelector, classifier, etc.) with only
 * the OpenCode client mocked.
 *
 * Flow tested:
 *   session.created (detect child) → reactive 429 (abort-only) → tool.execute.after (enhance output)
 */

import { HealthStore } from "../../src/health/store.js"
import { ModelSelector } from "../../src/selection/selector.js"
import { handleReactiveEvent } from "../../src/actions/reactive.js"
import { handleChatMessage } from "../../src/actions/preemptive.js"
import { BUILTIN_RULES } from "../../src/classification/patterns.js"
import { createLogger } from "../../src/logging/logger.js"
import { handleSessionCreated, handleToolExecuteAfter } from "../../src/index.js"
import type { Config } from "../../src/types.js"

// ─── Shared config factory ──────────────────────────────────────────────

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

// ─── Plugin context (real components) ───────────────────────────────────

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

// ─── Mock client factory ────────────────────────────────────────────────

function mockClient() {
  return {
    session: {
      abort: vi.fn().mockResolvedValue(undefined),
      revert: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockResolvedValue({ info: { id: "msg-reply" }, parts: [] }),
      messages: vi.fn().mockResolvedValue({
        data: [{
          info: {
            id: "msg-user-1",
            role: "user",
            model: { providerID: "zhipuai", modelID: "glm-5.1" },
            agent: "build",
          },
          parts: [{ type: "text", text: "test message" }],
        }],
      }),
    },
    tui: { showToast: vi.fn().mockResolvedValue(true) },
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("E2E: Subagent 429 recovery — full chain", () => {

  it("full chain: session.created → child 429 → abort-only → task returns", async () => {
    const ctx = createPluginContext()

    // Step 1: session.created — detect child session
    handleSessionCreated(
      { type: "session.created", properties: { sessionID: "child-s1", info: { parentID: "parent-s1" } } },
      ctx.childSessions,
      ctx.logger,
    )
    expect(ctx.childSessions.has("child-s1")).toBe(true)

    // Step 2: Cache the model info for the child session (simulates chat.message hook)
    ctx.messageCache.set("child-s1", [{
      modelKey: "zhipuai/glm-5.1",
      agentName: "build",
      messageID: "m1",
    }])

    // Step 3: 429 retry event → reactive handler (abort-only path for children)
    const client = mockClient()

    await handleReactiveEvent(
      {
        type: "session.status",
        properties: {
          sessionID: "child-s1",
          status: { type: "retry", attempt: 4, message: "429 Rate Limited" },
        },
      },
      {
        client: client as any,
        store: ctx.store,
        selector: ctx.selector,
        rules: ctx.config.classification.rules,
        maxRetries: 3,
        logger: ctx.logger,
        dedupSet: ctx.dedupSet,
        pluginPromptedSessions: ctx.pluginPromptedSessions,
        messageCache: ctx.messageCache,
        handledRetrySessions: ctx.handledRetrySessions,
        childSessions: ctx.childSessions,
        abortedChildren: ctx.abortedChildren,
      },
    )

    // Verify: abort-only path (no revert/prompt for child sessions)
    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: "child-s1" } })
    expect(client.session.abort).toHaveBeenCalledOnce()
    expect(client.session.revert).not.toHaveBeenCalled()
    expect(client.session.prompt).not.toHaveBeenCalled()

    // Verify: health score dropped for the model used by the child session
    expect(ctx.store.get("zhipuai/glm-5.1")).toBe(80) // 100 - 20 (failurePenalty)

    // Verify: abortedChildren tracks the child session
    expect(ctx.abortedChildren.has("child-s1")).toBe(true)
  })

  it("full chain: abort → tool.execute.after enhances task output", async () => {
    const ctx = createPluginContext()

    // Step 1: detect child session
    handleSessionCreated(
      { type: "session.created", properties: { sessionID: "child-s2", info: { parentID: "parent-s2" } } },
      ctx.childSessions,
      ctx.logger,
    )
    expect(ctx.childSessions.has("child-s2")).toBe(true)

    // Step 2: cache model info + trigger reactive abort
    ctx.messageCache.set("child-s2", [{
      modelKey: "zhipuai/glm-5.1",
      agentName: "build",
      messageID: "m1",
    }])

    const client = mockClient()
    await handleReactiveEvent(
      {
        type: "session.status",
        properties: {
          sessionID: "child-s2",
          status: { type: "retry", attempt: 4, message: "429 Rate Limited" },
        },
      },
      {
        client: client as any,
        store: ctx.store,
        selector: ctx.selector,
        rules: ctx.config.classification.rules,
        maxRetries: 3,
        logger: ctx.logger,
        dedupSet: ctx.dedupSet,
        pluginPromptedSessions: ctx.pluginPromptedSessions,
        messageCache: ctx.messageCache,
        handledRetrySessions: ctx.handledRetrySessions,
        childSessions: ctx.childSessions,
        abortedChildren: ctx.abortedChildren,
      },
    )
    expect(ctx.abortedChildren.has("child-s2")).toBe(true)

    // Step 3: tool.execute.after — task returns with child session ID in metadata
    const taskOutput: { output: string; metadata: Record<string, unknown> } = {
      output: "Task partially completed: processed 5 of 10 items",
      metadata: {
        sessionId: "child-s2",
        model: { providerID: "zhipuai", modelID: "glm-5.1" },
      },
    }

    handleToolExecuteAfter(
      { tool: "task", sessionID: "parent-s2" },
      taskOutput,
      ctx.abortedChildren,
      ctx.logger,
    )

    // Verify: output enhanced with child session ID, model name, export command, and 429 info
    expect(taskOutput.output).toContain("child-s2")
    expect(taskOutput.output).toContain("zhipuai/glm-5.1")
    expect(taskOutput.output).toContain("opencode export child-s2")
    expect(taskOutput.output).toContain("429")

    // Verify: original task output preserved
    expect(taskOutput.output).toContain("Task partially completed: processed 5 of 10 items")

    // Verify: abortedChildren consumed (session removed from set)
    expect(ctx.abortedChildren.has("child-s2")).toBe(false)
  })

  it("full chain: enhanced output format enables new subagent to continue", async () => {
    const ctx = createPluginContext()

    // Step 1: detect child session
    handleSessionCreated(
      { type: "session.created", properties: { sessionID: "child-s3", info: { parentID: "parent-s3" } } },
      ctx.childSessions,
      ctx.logger,
    )

    // Step 2: cache + reactive abort
    ctx.messageCache.set("child-s3", [{
      modelKey: "zhipuai/glm-5.1",
      agentName: "build",
      messageID: "m1",
    }])

    const client = mockClient()
    await handleReactiveEvent(
      {
        type: "session.status",
        properties: {
          sessionID: "child-s3",
          status: { type: "retry", attempt: 4, message: "429 已达到 5 小时的使用上限" },
        },
      },
      {
        client: client as any,
        store: ctx.store,
        selector: ctx.selector,
        rules: ctx.config.classification.rules,
        maxRetries: 3,
        logger: ctx.logger,
        dedupSet: ctx.dedupSet,
        pluginPromptedSessions: ctx.pluginPromptedSessions,
        messageCache: ctx.messageCache,
        handledRetrySessions: ctx.handledRetrySessions,
        childSessions: ctx.childSessions,
        abortedChildren: ctx.abortedChildren,
      },
    )
    expect(ctx.abortedChildren.has("child-s3")).toBe(true)

    // Step 3: tool.execute.after — enhance output
    const taskOutput: { output: string; metadata: Record<string, unknown> } = {
      output: "Built 3 components: Button, Input, Modal",
      metadata: {
        sessionId: "child-s3",
        model: { providerID: "zhipuai", modelID: "glm-5.1" },
      },
    }

    handleToolExecuteAfter(
      { tool: "task", sessionID: "parent-s3" },
      taskOutput,
      ctx.abortedChildren,
      ctx.logger,
    )

    // Verify: output contains the structured recovery information
    const outputLines = taskOutput.output.split("\n")
    // First part is the original output
    expect(outputLines[0]).toBe("Built 3 components: Button, Input, Modal")
    // Contains separator
    expect(outputLines).toContain("---")
    // Contains session ID for export command
    const sessionLine = outputLines.find(l => l.includes("child-s3") && l.includes("429"))
    expect(sessionLine).toBeDefined()
    // Contains export command that new subagent can parse
    const exportLine = outputLines.find(l => l.includes("opencode export child-s3"))
    expect(exportLine).toBeDefined()
    // Contains instructions for reading the old session
    const instructionLine = outputLines.find(l => l.includes("第一句") || l.includes("最后几句"))
    expect(instructionLine).toBeDefined()

    // Verify: model info extracted from metadata (not from args)
    const modelLine = outputLines.find(l => l.includes("zhipuai/glm-5.1"))
    expect(modelLine).toBeDefined()

    // Verify: abortedChildren consumed
    expect(ctx.abortedChildren.has("child-s3")).toBe(false)
  })

  it("health score propagation: child 429 → preemptive picks fallback", async () => {
    const ctx = createPluginContext()

    // Initialize scores: primary at 100, fallbacks at 100
    ctx.store._set("deepseek/v4-pro", { score: 100, lastRecoveryAt: 0 })
    ctx.store._set("deepseek/v4-flash", { score: 100, lastRecoveryAt: 0 })

    // Step 1: detect child session
    handleSessionCreated(
      { type: "session.created", properties: { sessionID: "child-s4", info: { parentID: "parent-s4" } } },
      ctx.childSessions,
      ctx.logger,
    )

    // Step 2: cache + reactive abort → glm-5.1 score drops to 80
    ctx.messageCache.set("child-s4", [{
      modelKey: "zhipuai/glm-5.1",
      agentName: "build",
      messageID: "m1",
    }])

    const client = mockClient()
    await handleReactiveEvent(
      {
        type: "session.status",
        properties: {
          sessionID: "child-s4",
          status: { type: "retry", attempt: 4, message: "429 Rate Limited" },
        },
      },
      {
        client: client as any,
        store: ctx.store,
        selector: ctx.selector,
        rules: ctx.config.classification.rules,
        maxRetries: 3,
        logger: ctx.logger,
        dedupSet: ctx.dedupSet,
        pluginPromptedSessions: ctx.pluginPromptedSessions,
        messageCache: ctx.messageCache,
        handledRetrySessions: ctx.handledRetrySessions,
        childSessions: ctx.childSessions,
        abortedChildren: ctx.abortedChildren,
      },
    )

    // Verify: glm-5.1 score dropped to 80
    expect(ctx.store.get("zhipuai/glm-5.1")).toBe(80)

    // Step 3: Preemptive check for a new session → should resolve to deepseek/v4-pro
    // (100 > 80, and v4-pro comes before v4-flash in the fallback chain)
    const resolved = ctx.selector.resolve("build")
    expect(resolved).not.toBeNull()
    expect(resolved).toBe("deepseek/v4-pro") // Highest score fallback (100 > 80)

    // Step 4: Verify the preemptive handler also switches correctly
    const output = {
      message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } },
      parts: [],
    }
    handleChatMessage(
      { sessionID: "new-ses", agent: "build", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
      output,
      ctx.store,
      ctx.config,
      ctx.logger,
    )
    // Preemptive should switch from low-score primary to highest-score fallback
    expect(output.message.model).toEqual({ providerID: "deepseek", modelID: "v4-pro" })
  })

  it("session.deleted cleans up childSessions and abortedChildren", async () => {
    const ctx = createPluginContext()

    // Step 1: Detect child session
    handleSessionCreated(
      { type: "session.created", properties: { sessionID: "child-del", info: { parentID: "parent-del" } } },
      ctx.childSessions, ctx.logger,
    )
    expect(ctx.childSessions.has("child-del")).toBe(true)

    // Step 2: Cache model info for the child
    ctx.messageCache.set("child-del", [{ modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "m1" }])

    // Step 3: Child hits 429 → abort-only path
    const client = mockClient()
    await handleReactiveEvent(
      { type: "session.status", properties: { sessionID: "child-del", status: { type: "retry", attempt: 4, message: "429 Rate Limited" } } },
      { client: client as any, store: ctx.store, selector: ctx.selector, rules: ctx.config.classification.rules, maxRetries: 3, logger: ctx.logger, dedupSet: ctx.dedupSet, pluginPromptedSessions: ctx.pluginPromptedSessions, messageCache: ctx.messageCache, handledRetrySessions: ctx.handledRetrySessions, childSessions: ctx.childSessions, abortedChildren: ctx.abortedChildren },
    )

    expect(ctx.childSessions.has("child-del")).toBe(true)
    expect(ctx.abortedChildren.has("child-del")).toBe(true)

    // Step 4: Simulate session.deleted cleanup (mirrors index.ts session.deleted handler)
    ctx.childSessions.delete("child-del")
    ctx.abortedChildren.delete("child-del")
    ctx.messageCache.delete("child-del")
    ctx.handledRetrySessions.delete("child-del")

    // Verify all sets are clean
    expect(ctx.childSessions.has("child-del")).toBe(false)
    expect(ctx.abortedChildren.has("child-del")).toBe(false)
    expect(ctx.messageCache.has("child-del")).toBe(false)
    expect(ctx.handledRetrySessions.has("child-del")).toBe(false)
  })

  it("concurrent child sessions: both get aborted independently", async () => {
    const ctx = createPluginContext()

    // Step 1: Two child sessions created simultaneously
    handleSessionCreated(
      { type: "session.created", properties: { sessionID: "child-a", info: { parentID: "parent-1" } } },
      ctx.childSessions, ctx.logger,
    )
    handleSessionCreated(
      { type: "session.created", properties: { sessionID: "child-b", info: { parentID: "parent-1" } } },
      ctx.childSessions, ctx.logger,
    )

    // Step 2: Both have cached model info
    ctx.messageCache.set("child-a", [{ modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "m1" }])
    ctx.messageCache.set("child-b", [{ modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "m2" }])

    // Step 3: Both hit 429 — handled independently
    const client = mockClient()
    await handleReactiveEvent(
      { type: "session.status", properties: { sessionID: "child-a", status: { type: "retry", attempt: 4, message: "429 Rate Limited" } } },
      { client: client as any, store: ctx.store, selector: ctx.selector, rules: ctx.config.classification.rules, maxRetries: 3, logger: ctx.logger, dedupSet: ctx.dedupSet, pluginPromptedSessions: ctx.pluginPromptedSessions, messageCache: ctx.messageCache, handledRetrySessions: ctx.handledRetrySessions, childSessions: ctx.childSessions, abortedChildren: ctx.abortedChildren },
    )
    await handleReactiveEvent(
      { type: "session.status", properties: { sessionID: "child-b", status: { type: "retry", attempt: 4, message: "429 Rate Limited" } } },
      { client: client as any, store: ctx.store, selector: ctx.selector, rules: ctx.config.classification.rules, maxRetries: 3, logger: ctx.logger, dedupSet: ctx.dedupSet, pluginPromptedSessions: ctx.pluginPromptedSessions, messageCache: ctx.messageCache, handledRetrySessions: ctx.handledRetrySessions, childSessions: ctx.childSessions, abortedChildren: ctx.abortedChildren },
    )

    // Both aborted
    expect(client.session.abort).toHaveBeenCalledTimes(2)
    // Both tracked in abortedChildren
    expect(ctx.abortedChildren.has("child-a")).toBe(true)
    expect(ctx.abortedChildren.has("child-b")).toBe(true)
    // Score: 100 - 20 - 20 = 60 (same model key, two failures)
    expect(ctx.store.get("zhipuai/glm-5.1")).toBe(60)

    // Step 4: tool.execute.after handles each task independently
    const outputA: { output: string; metadata: Record<string, unknown> } = {
      output: "Task A result",
      metadata: { sessionId: "child-a", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
    }
    handleToolExecuteAfter({ tool: "task", sessionID: "parent-1" }, outputA, ctx.abortedChildren, ctx.logger)
    expect(outputA.output).toContain("child-a")
    expect(ctx.abortedChildren.has("child-a")).toBe(false) // consumed
    expect(ctx.abortedChildren.has("child-b")).toBe(true) // still pending

    const outputB: { output: string; metadata: Record<string, unknown> } = {
      output: "Task B result",
      metadata: { sessionId: "child-b", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
    }
    handleToolExecuteAfter({ tool: "task", sessionID: "parent-1" }, outputB, ctx.abortedChildren, ctx.logger)
    expect(outputB.output).toContain("child-b")
    expect(ctx.abortedChildren.has("child-b")).toBe(false) // consumed
  })

  it("full lifecycle: parent dispatches child → 429 → abort → tool.after → re-dispatch → preemptive switch", async () => {
    const ctx = createPluginContext()
    ctx.store._set("deepseek/v4-pro", { score: 100, lastRecoveryAt: 0 })

    // === Phase 1: Parent session caches model info (simulates chat.message hook) ===
    ctx.messageCache.set("parent-lc", [{
      modelKey: "zhipuai/glm-5.1",
      agentName: "build",
      messageID: "parent-msg-1",
    }])

    // === Phase 2: Parent dispatches child (task tool) ===
    handleSessionCreated(
      { type: "session.created", properties: { sessionID: "child-lc", info: { parentID: "parent-lc" } } },
      ctx.childSessions, ctx.logger,
    )
    expect(ctx.childSessions.has("child-lc")).toBe(true)

    // Child session also caches its model info
    ctx.messageCache.set("child-lc", [{
      modelKey: "zhipuai/glm-5.1",
      agentName: "build",
      messageID: "child-msg-1",
    }])

    // === Phase 3: Child hits 429 → abort-only path ===
    const client = mockClient()
    await handleReactiveEvent(
      { type: "session.status", properties: { sessionID: "child-lc", status: { type: "retry", attempt: 4, message: "429 Rate Limited" } } },
      { client: client as any, store: ctx.store, selector: ctx.selector, rules: ctx.config.classification.rules, maxRetries: 3, logger: ctx.logger, dedupSet: ctx.dedupSet, pluginPromptedSessions: ctx.pluginPromptedSessions, messageCache: ctx.messageCache, handledRetrySessions: ctx.handledRetrySessions, childSessions: ctx.childSessions, abortedChildren: ctx.abortedChildren },
    )

    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: "child-lc" } })
    expect(client.session.revert).not.toHaveBeenCalled()
    expect(ctx.store.get("zhipuai/glm-5.1")).toBe(80)
    expect(ctx.abortedChildren.has("child-lc")).toBe(true)

    // === Phase 4: task returns → tool.execute.after enhances output ===
    const taskOutput: { output: string; metadata: Record<string, unknown> } = {
      output: "Partially completed: implemented auth module",
      metadata: { sessionId: "child-lc", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
    }
    handleToolExecuteAfter(
      { tool: "task", sessionID: "parent-lc" },
      taskOutput, ctx.abortedChildren, ctx.logger,
    )
    expect(taskOutput.output).toContain("child-lc")
    expect(taskOutput.output).toContain("opencode export child-lc")
    expect(ctx.abortedChildren.has("child-lc")).toBe(false)

    // === Phase 5: Parent AI sees enhanced output → re-dispatches → preemptive handler switches model ===
    const preemptiveOutput = {
      message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } },
      parts: [],
    }
    handleChatMessage(
      { sessionID: "parent-lc", agent: "build", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
      preemptiveOutput,
      ctx.store,
      ctx.config,
      ctx.logger,
    )
    // glm-5.1 is at 80, deepseek/v4-pro is at 100 → preemptive switches to v4-pro
    expect(preemptiveOutput.message.model).toEqual({ providerID: "deepseek", modelID: "v4-pro" })
  })
})
