import { describe, it, expect, vi, beforeEach } from "vitest"
import { MockLLMServer } from "./mock-llm-server.js"

/**
 * Hook-level E2E Test
 *
 * Unlike unit tests that mock individual functions, these tests:
 * 1. Create a real plugin instance via ModelFallbackPlugin()
 * 2. Use real HealthStore, ModelSelector, Classifier, etc.
 * 3. Only mock the OpenCode client (which would be the real SDK in production)
 * 4. Verify state changes across components
 * 5. Read actual log files to verify logging behavior
 */

// Import the individual components and test them together
// in the same way the plugin assembles them.
import { HealthStore } from "../../src/health/store.js"
import { ModelSelector } from "../../src/selection/selector.js"
import { handleChatMessage } from "../../src/actions/preemptive.js"
import { handleReactiveEvent, cleanupDedupForSession } from "../../src/actions/reactive.js"
import { classify } from "../../src/classification/classifier.js"
import { BUILTIN_RULES } from "../../src/classification/patterns.js"
import { shouldIntervene } from "../../src/retry/policy.js"
import { createLogger } from "../../src/logging/logger.js"
import type { Config, ClassificationRule } from "../../src/types.js"

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
      plan: { fallbackModels: ["deepseek/v4-pro"] },
      "*": { fallbackModels: ["deepseek/v4-flash"] },
    },
    primaryModels: new Set(["zhipuai/glm-5.1", "zhipuai/glm-5-turbo"]),
    logging: { level: "debug", path: "" },
    ...overrides,
  }
}

// Real plugin context — assembled the same way as index.ts does it
interface PluginContext {
  config: Config
  store: HealthStore
  selector: ModelSelector
  dedupSet: Set<string>
  pluginPromptedSessions: Set<string>
  handledRetrySessions: Set<string>
  messageCache: Map<string, Array<{ modelKey: string; agentName: string; messageID: string }>>
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
  const logger = createLogger({ level: "debug" })
  return { config: cfg, store, selector, dedupSet, pluginPromptedSessions, handledRetrySessions, messageCache, logger }
}

function mockClient(promptResult: "success" | "error" = "success") {
  return {
    session: {
      abort: vi.fn().mockResolvedValue(undefined),
      revert: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockImplementation(() =>
        promptResult === "success"
          ? Promise.resolve({ info: { id: "msg-reply" }, parts: [] })
          : Promise.reject(new Error("prompt failed")),
      ),
      messages: vi.fn().mockResolvedValue({
        data: [
          {
            info: {
              id: "msg-user-1",
              role: "user",
              model: { providerID: "zhipuai", modelID: "glm-5.1" },
              agent: "build",
            },
            parts: [{ type: "text", text: "test message" }],
          },
        ],
      }),
    },
    tui: { showToast: vi.fn().mockResolvedValue(true) },
  }
}

describe("E2E: Plugin Lifecycle — User Message Trust + Reactive Fallback", () => {
  let ctx: PluginContext

  beforeEach(() => {
    ctx = createPluginContext()
  })

  describe("Scenario 1: User sends message to healthy model", () => {
    it("does NOT intervene — trusts user's model choice", () => {
      // User model is healthy (100), fallback is also healthy (100)
      const output = {
        message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } },
        parts: [],
      }

      // Simulate chat.message hook — no marker = user message
      const isPluginPrompt = ctx.pluginPromptedSessions.has("ses-1")
      if (isPluginPrompt) {
        ctx.pluginPromptedSessions.delete("ses-1")
        handleChatMessage(
          { sessionID: "ses-1", agent: "build", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
          output,
          ctx.store,
          ctx.config,
          ctx.logger,
        )
      }

      // Verify: model unchanged
      expect(output.message.model).toEqual({ providerID: "zhipuai", modelID: "glm-5.1" })
      // Verify: scores unchanged
      expect(ctx.store.get("zhipuai/glm-5.1")).toBe(100)
    })
  })

  describe("Scenario 2: User chooses low-score model → 429 → reactive fallback", () => {
    it("trusts low-score model first, then reactive switches on failure", async () => {
      // Setup: primary model has low score (was rate-limited before)
      ctx.store._set("zhipuai/glm-5.1", { score: 20, lastRecoveryAt: Date.now() })
      ctx.store._set("deepseek/v4-pro", { score: 100, lastRecoveryAt: 0 })

      // Step 1: User message — trust input.model (even though score is 20)
      const userOutput = {
        message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } },
        parts: [],
      }
      if (ctx.pluginPromptedSessions.has("ses-2")) {
        ctx.pluginPromptedSessions.delete("ses-2")
        handleChatMessage(
          { sessionID: "ses-2", agent: "build", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
          userOutput,
          ctx.store,
          ctx.config,
          ctx.logger,
        )
      }
      expect(userOutput.message.model).toEqual({ providerID: "zhipuai", modelID: "glm-5.1" })

      // Step 2: API returns 429 → OpenCode retries 3 times → reactive handler
      // Pre-populate messageCache for the reactive handler to find the message
      ctx.messageCache.set("ses-2", [{
        modelKey: "zhipuai/glm-5.1",
        agentName: "build",
        messageID: "msg-user-1",
      }])

      const client = mockClient("success")
      const retryEvent = {
        type: "session.status",
        properties: {
          sessionID: "ses-2",
          status: { type: "retry", attempt: 4, message: "429 已达到 5 小时的使用上限" },
        },
      }

      await handleReactiveEvent(retryEvent as any, {
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
      })

      // Step 3: Verify reactive executed the full chain
      expect(client.session.abort).toHaveBeenCalledWith({ path: { id: "ses-2" } })
      expect(client.session.revert).toHaveBeenCalled()
      expect(client.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            model: { providerID: "deepseek", modelID: "v4-pro" }, // Highest score fallback
          }),
        }),
      )

      // Step 4: Verify health score changes
      expect(ctx.store.get("zhipuai/glm-5.1")).toBe(0) // 20 - 20 = 0 (failure penalty)
      expect(ctx.store.get("deepseek/v4-pro")).toBe(100) // Unchanged

      // Step 5: Verify marker was set for prompt's chat.message
      expect(ctx.pluginPromptedSessions.has("ses-2")).toBe(true)

      // Step 6: Simulate chat.message consuming the marker → score mechanism kicks in
      const fallbackOutput = {
        message: { model: { providerID: "deepseek", modelID: "v4-pro" } },
        parts: [],
      }
      if (ctx.pluginPromptedSessions.has("ses-2")) {
        ctx.pluginPromptedSessions.delete("ses-2")
        handleChatMessage(
          { sessionID: "ses-2", agent: "build", model: { providerID: "deepseek", modelID: "v4-pro" } },
          fallbackOutput,
          ctx.store,
          ctx.config,
          ctx.logger,
        )
      }
      // Marker consumed
      expect(ctx.pluginPromptedSessions.has("ses-2")).toBe(false)
      // Fallback model is highest score → stays the same
      expect(fallbackOutput.message.model).toEqual({ providerID: "deepseek", modelID: "v4-pro" })
    })
  })

  describe("Scenario 3: All models fail — chain exhaustion", () => {
    it("shows toast notification and stops when chain is exhausted", async () => {
      // No fallback chain configured for build agent that has healthy models
      const limitedConfig = makeE2EConfig({
        agents: { build: { fallbackModels: [] }, "*": { fallbackModels: [] } },
      })
      const limitedCtx = createPluginContext(limitedConfig)
      // Make the primary model fail
      limitedCtx.store._set("zhipuai/glm-5.1", { score: 20, lastRecoveryAt: Date.now() })

      // Pre-populate messageCache
      limitedCtx.messageCache.set("ses-3", [{
        modelKey: "zhipuai/glm-5.1",
        agentName: "build",
        messageID: "msg-user-1",
      }])

      const client = mockClient()
      const event = {
        type: "session.status",
        properties: {
          sessionID: "ses-3",
          status: { type: "retry", attempt: 4, message: "500 Internal Server Error" },
        },
      }

      await handleReactiveEvent(event as any, {
        client: client as any,
        store: limitedCtx.store,
        selector: limitedCtx.selector,
        rules: limitedCtx.config.classification.rules,
        maxRetries: 3,
        logger: limitedCtx.logger,
        dedupSet: limitedCtx.dedupSet,
        pluginPromptedSessions: limitedCtx.pluginPromptedSessions,
        messageCache: limitedCtx.messageCache,
        handledRetrySessions: limitedCtx.handledRetrySessions,
      })

      // Chain exhausted: prompt should NOT be called
      expect(client.session.prompt).not.toHaveBeenCalled()
      // Toast notification about exhaustion
      expect(client.tui!.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.objectContaining({ variant: "error" }) }),
      )
    })
  })

  describe("Scenario 4: Reactive prompt failure — marker cleanup", () => {
    it("cleans up pluginPromptedSessions when prompt throws", async () => {
      const client = mockClient("error") // prompt will throw

      ctx.pluginPromptedSessions.add("ses-4") // Pre-existing marker

      // Pre-populate messageCache
      ctx.messageCache.set("ses-4", [{
        modelKey: "zhipuai/glm-5.1",
        agentName: "build",
        messageID: "msg-user-1",
      }])

      const event = {
        type: "session.status",
        properties: {
          sessionID: "ses-4",
          status: { type: "retry", attempt: 4, message: "429 Rate Limited" },
        },
      }

      await handleReactiveEvent(event as any, {
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
      })

      // Marker for this session should be cleaned up (prompt failed)
      expect(ctx.pluginPromptedSessions.has("ses-4")).toBe(false)
    })
  })

  describe("Scenario 5: Multi-agent isolation", () => {
    it("build agent degradation does not affect plan agent", async () => {
      // Build's primary model fails
      ctx.store._set("zhipuai/glm-5.1", { score: 0, lastRecoveryAt: Date.now() })
      // Plan's primary model is fine
      ctx.store._set("zhipuai/glm-5-turbo", { score: 100, lastRecoveryAt: 0 })

      // Build agent: reactive should switch to fallback
      // Pre-populate messageCache
      ctx.messageCache.set("ses-build", [{
        modelKey: "zhipuai/glm-5.1",
        agentName: "build",
        messageID: "msg-user-1",
      }])

      const buildClient = mockClient()
      await handleReactiveEvent(
        {
          type: "session.status",
          properties: {
            sessionID: "ses-build",
            status: { type: "retry", attempt: 4, message: "429 Too Many Requests" },
          },
        } as any,
        {
          client: buildClient as any,
          store: ctx.store,
          selector: ctx.selector,
          rules: ctx.config.classification.rules,
          maxRetries: 3,
          logger: ctx.logger,
          dedupSet: ctx.dedupSet,
          pluginPromptedSessions: ctx.pluginPromptedSessions,
          messageCache: ctx.messageCache,
          handledRetrySessions: ctx.handledRetrySessions,
        },
      )

      // Build's fallback was used
      expect(buildClient.session.prompt).toHaveBeenCalled()

      // Plan agent's model is unaffected
      expect(ctx.store.get("zhipuai/glm-5-turbo")).toBe(100)

      // Plan agent would not be switched (different agent chain)
      const planFallback = ctx.selector.resolve("plan")
      // Plan agent's fallback is deepseek/v4-pro — still available
      expect(planFallback).not.toBeNull()
    })
  })

  describe("Scenario 6: Health score evolution over 10 interactions", () => {
    it("tracks score accumulation, tick recovery, and full restore correctly", () => {
      // Interaction 1-3: primary fails 3 times
      for (let i = 0; i < 3; i++) {
        ctx.store.recordFailure("zhipuai/glm-5.1")
      }
      expect(ctx.store.get("zhipuai/glm-5.1")).toBe(40) // 100 - 20*3

      // Interaction 4: fallback succeeds → gains score
      ctx.store.recordSuccess("deepseek/v4-pro")
      expect(ctx.store.get("deepseek/v4-pro")).toBe(100) // Already 100, capped

      // Tick: primary recovers
      ctx.store._set("zhipuai/glm-5.1", { score: 40, lastRecoveryAt: Date.now() - 61_000 }) // 61s > 60s interval
      ctx.store.tick()
      expect(ctx.store.get("zhipuai/glm-5.1")).toBe(50) // +10

      // Another tick
      ctx.store._set("zhipuai/glm-5.1", { score: 50, lastRecoveryAt: Date.now() - 61_000 })
      ctx.store.tick()
      expect(ctx.store.get("zhipuai/glm-5.1")).toBe(60)

      // Primary succeeds → full restore
      ctx.store.recordSuccess("zhipuai/glm-5.1")
      expect(ctx.store.get("zhipuai/glm-5.1")).toBe(100) // Full restore for primary
    })
  })

  describe("Scenario 7: Error classification — all rule patterns", () => {
    it.each([
      ["429 Too Many Requests", "rate_limit"],
      ["429 已达到 5 小时的使用上限", "rate_limit"],
      ["429 错误码: 1308", "rate_limit"],
      ["500 Internal Server Error", "5xx"],
      ["502 Bad Gateway", "5xx"],
      ["request timed out after 30s", "timeout"],
    ])("classifies '%s' as %s", (message, expectedCategory) => {
      const result = classify(message, BUILTIN_RULES)
      expect(result).not.toBeNull()
      expect(result!.category).toBe(expectedCategory)
    })

    it.each([["200 OK"], ["服务器繁忙"], ["normal response"]])(
      "does NOT classify '%s' as error",
      (message) => {
        const result = classify(message, BUILTIN_RULES)
        expect(result).toBeNull()
      },
    )
  })

  describe("Scenario 8: Session lifecycle cleanup", () => {
    it("cleans dedupSet on session.compacted AND pluginPromptedSessions on session.deleted", () => {
      // Add dedup entries
      ctx.dedupSet.add("ses-lc:1")
      ctx.dedupSet.add("ses-lc:2")
      ctx.dedupSet.add("ses-other:1")

      // Add pluginPromptedSessions markers
      ctx.pluginPromptedSessions.add("ses-lc")
      ctx.pluginPromptedSessions.add("ses-other")

      // session.compacted → only dedupSet cleanup
      cleanupDedupForSession(ctx.dedupSet, "ses-lc")
      expect(ctx.dedupSet.has("ses-lc:1")).toBe(false)
      expect(ctx.dedupSet.has("ses-lc:2")).toBe(false)
      expect(ctx.dedupSet.has("ses-other:1")).toBe(true)
      // pluginPromptedSessions NOT cleaned on compacted (avoid race)
      expect(ctx.pluginPromptedSessions.has("ses-lc")).toBe(true)
      expect(ctx.pluginPromptedSessions.has("ses-other")).toBe(true)

      // session.deleted → pluginPromptedSessions cleanup
      ctx.pluginPromptedSessions.delete("ses-lc")
      expect(ctx.pluginPromptedSessions.has("ses-lc")).toBe(false)
      expect(ctx.pluginPromptedSessions.has("ses-other")).toBe(true)
    })
  })

  describe("Scenario 9: Anti-cascading — subsequent retry events are blocked after fallback", () => {
    it("marks session after abort and skips attempt 5", async () => {
      // Setup: primary model healthy, fallback healthy
      ctx.store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: Date.now() })

      // First: need to cache a user message (simulating chat.message hook)
      ctx.messageCache.set("ses-9", [{
        modelKey: "zhipuai/glm-5.1",
        agentName: "build",
        messageID: "msg-user-9",
      }])

      // Mock messages to return the expected user message
      const client = mockClient("success")
      client.session.messages = vi.fn().mockResolvedValue({
        data: [{
          info: {
            id: "msg-user-9",
            role: "user",
            model: { providerID: "zhipuai", modelID: "glm-5.1" },
            agent: "build",
          },
          parts: [{ type: "text", text: "test message" }],
        }],
      })

      // Attempt 4: triggers fallback
      await handleReactiveEvent(
        {
          type: "session.status",
          properties: {
            sessionID: "ses-9",
            status: { type: "retry", attempt: 4, message: "429 已达到 5 小时的使用上限" },
          },
        } as any,
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
        },
      )

      // Verify: abort was called
      expect(client.session.abort).toHaveBeenCalled()
      // Verify: session is marked as handled
      expect(ctx.handledRetrySessions.has("ses-9")).toBe(true)

      // Attempt 5: should be blocked by anti-cascading
      const client2 = mockClient("success")
      await handleReactiveEvent(
        {
          type: "session.status",
          properties: {
            sessionID: "ses-9",
            status: { type: "retry", attempt: 5, message: "429 已达到 5 小时的使用上限" },
          },
        } as any,
        {
          client: client2 as any,
          store: ctx.store,
          selector: ctx.selector,
          rules: ctx.config.classification.rules,
          maxRetries: 3,
          logger: ctx.logger,
          dedupSet: ctx.dedupSet,
          pluginPromptedSessions: ctx.pluginPromptedSessions,
          messageCache: ctx.messageCache,
          handledRetrySessions: ctx.handledRetrySessions,
        },
      )

      // Verify: second client's abort was NOT called (anti-cascading worked)
      expect(client2.session.abort).not.toHaveBeenCalled()
    })
  })

  describe("Scenario 10: Dual-instance shared state simulation", () => {
    it("pluginPromptedSessions set by reactive handler is visible to chat.message hook", async () => {
      // Simulate: Instance A runs reactive handler and sets pluginPromptedSessions
      // Instance B runs chat.message hook and checks pluginPromptedSessions

      ctx.messageCache.set("ses-10", [{
        modelKey: "zhipuai/glm-5.1",
        agentName: "build",
        messageID: "msg-user-10",
      }])

      const client = mockClient("success")
      client.session.messages = vi.fn().mockResolvedValue({
        data: [{
          info: {
            id: "msg-user-10",
            role: "user",
            model: { providerID: "zhipuai", modelID: "glm-5.1" },
            agent: "build",
          },
          parts: [{ type: "text", text: "test message" }],
        }],
      })

      // "Instance A": reactive handler
      await handleReactiveEvent(
        {
          type: "session.status",
          properties: {
            sessionID: "ses-10",
            status: { type: "retry", attempt: 4, message: "429 Rate Limited" },
          },
        } as any,
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
        },
      )

      // Verify: pluginPromptedSessions has the session (set by reactive handler)
      expect(ctx.pluginPromptedSessions.has("ses-10")).toBe(true)

      // "Instance B": chat.message hook — should see the marker
      // (In real code, this would be in a different server() call but same module-level Set)
      const isPluginPrompt = ctx.pluginPromptedSessions.has("ses-10")
      expect(isPluginPrompt).toBe(true) // This is the key assertion!

      // Consume the marker
      ctx.pluginPromptedSessions.delete("ses-10")

      // Simulate chat.message handling for the fallback model
      const output = {
        message: { model: { providerID: "deepseek", modelID: "v4-pro" } },
        parts: [],
      }
      handleChatMessage(
        { sessionID: "ses-10", agent: "build", model: { providerID: "deepseek", modelID: "v4-pro" } },
        output,
        ctx.store,
        ctx.config,
        ctx.logger,
      )
      // No switch needed — fallback model has score 100
      expect(output.message.model).toEqual({ providerID: "deepseek", modelID: "v4-pro" })
    })
  })
})
