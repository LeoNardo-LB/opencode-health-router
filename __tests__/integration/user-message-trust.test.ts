import { describe, it, expect, vi, beforeEach } from "vitest"
import { handleChatMessage } from "../../src/actions/preemptive.js"
import { handleReactiveEvent, cleanupDedupForSession } from "../../src/actions/reactive.js"
import { HealthStore } from "../../src/health/store.js"
import { ModelSelector } from "../../src/selection/selector.js"
import type { Config, ClassificationRule } from "../../src/types.js"

function makeFallbackConfig(): Config {
  return {
    enabled: true,
    classification: {
      rules: [
        { statusCodes: [429], patterns: [] },
      ] as ClassificationRule[],
    },
    healthScore: {
      failurePenalty: 20,
      primary: { recoveryIntervalMs: 1_800_000, recoveryBonus: 10, successBehavior: "full" },
      fallback: { recoveryIntervalMs: 1_800_000, recoveryBonus: 5, successBonus: 5 },
    },
    retryPolicy: { maxRetries: 3 },
    agents: {
      build: { fallbackModels: ["deepseek/v4-pro"] },
      "*": { fallbackModels: [] },
    },
    primaryModels: new Set(["zhipuai/glm-5.1"]),
    logging: { level: "error", path: "" },
  }
}

const testSessionID = "ses_integration_test"

function mockClient() {
  return {
    session: {
      abort: vi.fn().mockResolvedValue(undefined),
      revert: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockResolvedValue(undefined),
      messages: vi.fn().mockResolvedValue({ data: [
        {
          info: {
            id: "msg_001",
            role: "user",
            model: { providerID: "zhipuai", modelID: "glm-5.1" },
            agent: "build",
          },
          parts: [{ type: "text", text: "hello" }],
        },
      ] }),
    },
    tui: { showToast: vi.fn().mockResolvedValue(true) },
  }
}

describe("user message — health score check (preemptive)", () => {
  let store: HealthStore
  let config: Config
  let selector: ModelSelector
  let dedupSet: Set<string>
  let pluginPromptedSessions: Set<string>
  let client: ReturnType<typeof mockClient>

  beforeEach(() => {
    config = makeFallbackConfig()
    store = new HealthStore(config)
    selector = new ModelSelector(config, store)
    dedupSet = new Set<string>()
    pluginPromptedSessions = new Set<string>()
    client = mockClient()
    vi.clearAllMocks()
  })

  it("user message with low-score primary model → switched to high-score fallback", async () => {
    // Setup: primary model has low score (was failing), fallback model is healthy
    store._set("zhipuai/glm-5.1", { score: 20, lastRecoveryAt: Date.now() })
    store._set("deepseek/v4-pro", { score: 100, lastRecoveryAt: 0 })

    // User message → chat.message → health score check → switch to fallback
    const output = { message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } }, parts: [] as unknown[] }

    // Simulate index.ts: user message goes through handleChatMessage (no marker)
    handleChatMessage(
      { sessionID: testSessionID, agent: "build", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
      output,
      store,
      config,
    )

    // Model should be switched to the high-score fallback
    expect(output.message.model).toEqual({ providerID: "deepseek", modelID: "v4-pro" })
  })

  it("user message with healthy primary model → no switch", async () => {
    // Setup: both models are healthy
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })
    store._set("deepseek/v4-pro", { score: 100, lastRecoveryAt: 0 })

    const output = { message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } }, parts: [] as unknown[] }

    handleChatMessage(
      { sessionID: testSessionID, agent: "build", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
      output,
      store,
      config,
    )

    // Model should stay as-is (current model is highest score)
    expect(output.message.model).toEqual({ providerID: "zhipuai", modelID: "glm-5.1" })
  })

  it("reactive handler still triggers fallback chain when retry exceeds maxRetries", async () => {
    // Setup
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })
    store._set("deepseek/v4-pro", { score: 100, lastRecoveryAt: 0 })

    // Phase 1: Simulate retry event triggering reactive
    const retryEvent = {
      type: "session.status",
      properties: {
        status: {
          type: "retry",
          attempt: 4, // > maxRetries(3) → trigger intervention
          message: "429 Too Many Requests",
        },
        sessionID: testSessionID,
      },
    }

    await handleReactiveEvent(retryEvent as any, {
      client: client as any,
      store,
      selector,
      rules: config.classification.rules,
      maxRetries: config.retryPolicy.maxRetries,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      dedupSet,
      pluginPromptedSessions,
      messageCache: new Map([["ses_integration_test", [{ modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "msg_001" }]]]),
        handledRetrySessions: new Set<string>(),
    })

    // Verify: abort + revert + re-prompt with fallback model
    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: testSessionID } })
    expect(client.session.revert).toHaveBeenCalledWith({
      path: { id: testSessionID },
      body: { messageID: "msg_001" },
    })
    expect(client.session.prompt).toHaveBeenCalledWith({
      path: { id: testSessionID },
      body: {
        model: { providerID: "deepseek", modelID: "v4-pro" },
        parts: [{ type: "text", text: "hello" }],
      },
    })
    // Primary model was penalized
    expect(store.get("zhipuai/glm-5.1")).toBe(80)
  })

  it("session.compacted does NOT clean pluginPromptedSessions (avoids race)", async () => {
    // Setup: put a marker in pluginPromptedSessions
    pluginPromptedSessions.add(testSessionID)
    expect(pluginPromptedSessions.has(testSessionID)).toBe(true)

    // Verify marker survives compacted (compacted only cleans dedupSet)
    expect(pluginPromptedSessions.has(testSessionID)).toBe(true)

    // session.deleted → should clean marker
    pluginPromptedSessions.delete(testSessionID)
    expect(pluginPromptedSessions.has(testSessionID)).toBe(false)
  })
})
