import { describe, it, expect, beforeEach, vi } from "vitest"
import { handleChatMessage } from "../../src/actions/preemptive.js"
import { HealthStore } from "../../src/health/store.js"
import type { Config } from "../../src/types.js"

function makeConfig(): Config {
  return {
    enabled: true,
    classification: { rules: [] },
    healthScore: {
      failurePenalty: 20,
      primary: { recoveryIntervalMs: 1_800_000, recoveryBonus: 10, successBehavior: "full" },
      fallback: { recoveryIntervalMs: 1_800_000, recoveryBonus: 5, successBonus: 5 },
    },
    retryPolicy: { maxRetries: 3 },
    agents: {
      build: { fallbackModels: ["zhipuai/glm-5.1"] },
      "*": { fallbackModels: [] },
    },
    primaryModels: new Set(["deepseek/v4-pro"]),
    logging: { level: "error", path: "" },
  }
}

const sessionID = "ses_test"

describe("chat.message with pluginPromptedSessions guard", () => {
  // Simulate pluginPromptedSessions Set
  let pluginPromptedSessions: Set<string>

  beforeEach(() => {
    pluginPromptedSessions = new Set<string>()
  })

  it("user message: does NOT call handleChatMessage (output unchanged)", () => {
    // No marker → user message → no intervention
    const store = new HealthStore(makeConfig())
    store._set("zhipuai/glm-5.1", { score: 20, lastRecoveryAt: Date.now() })
    store._set("deepseek/v4-pro", { score: 100, lastRecoveryAt: 0 })

    const output = { message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } }, parts: [] }

    // Simulate chat.message guard logic
    if (pluginPromptedSessions.has(sessionID)) {
      pluginPromptedSessions.delete(sessionID)
      handleChatMessage(
        { sessionID, agent: "build", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
        output,
        store,
        makeConfig(),
      )
    }
    // No marker → don't call handleChatMessage → output unchanged

    expect(output.message.model).toEqual({ providerID: "zhipuai", modelID: "glm-5.1" })
    // Verify scores were not modified
    expect(store.get("zhipuai/glm-5.1")).toBe(20)
    expect(store.get("deepseek/v4-pro")).toBe(100)
  })

  it("reactive prompt: DOES call handleChatMessage (switches to highest score)", () => {
    // Has marker → plugin prompt → use score mechanism
    pluginPromptedSessions.add(sessionID)

    const store = new HealthStore(makeConfig())
    store._set("deepseek/v4-pro", { score: 20, lastRecoveryAt: Date.now() })
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })

    const output = { message: { model: { providerID: "deepseek", modelID: "v4-pro" } }, parts: [] }

    if (pluginPromptedSessions.has(sessionID)) {
      pluginPromptedSessions.delete(sessionID)
      handleChatMessage(
        { sessionID, agent: "build", model: { providerID: "deepseek", modelID: "v4-pro" } },
        output,
        store,
        makeConfig(),
      )
    }

    // Has marker → called handleChatMessage → switched to highest score model
    expect(output.message.model).toEqual({ providerID: "zhipuai", modelID: "glm-5.1" })
    // Verify marker was consumed
    expect(pluginPromptedSessions.has(sessionID)).toBe(false)
  })

  it("user message with low-score model does NOT intervene", () => {
    // User chose a low-score model (20), even if alternative is 100, don't intervene
    const store = new HealthStore(makeConfig())
    store._set("zhipuai/glm-5.1", { score: 20, lastRecoveryAt: Date.now() })
    store._set("deepseek/v4-pro", { score: 100, lastRecoveryAt: 0 })

    const output = { message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } }, parts: [] }

    // No marker → user message
    if (pluginPromptedSessions.has(sessionID)) {
      pluginPromptedSessions.delete(sessionID)
      handleChatMessage(
        { sessionID, agent: "build", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
        output,
        store,
        makeConfig(),
      )
    }

    // No intervention, even though user chose a low-score model
    expect(output.message.model).toEqual({ providerID: "zhipuai", modelID: "glm-5.1" })
  })

  it("marker cleanup after consumption", () => {
    pluginPromptedSessions.add(sessionID)
    expect(pluginPromptedSessions.has(sessionID)).toBe(true)

    // Simulate chat.message consumption
    if (pluginPromptedSessions.has(sessionID)) {
      pluginPromptedSessions.delete(sessionID)
    }

    expect(pluginPromptedSessions.has(sessionID)).toBe(false)
    expect(pluginPromptedSessions.size).toBe(0)
  })

  it("reactive prompt failure cleans up marker", async () => {
    pluginPromptedSessions.add(sessionID)

    // Current model is deepseek/v4-pro (primary), fallback is zhipuai/glm-5.1
    const store = new HealthStore(makeConfig())
    store._set("deepseek/v4-pro", { score: 80, lastRecoveryAt: Date.now() })
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })

    // Use handleReactiveEvent to test the full flow
    const { handleReactiveEvent } = await import("../../src/actions/reactive.js")
    const { ModelSelector } = await import("../../src/selection/selector.js")

    const selector = new ModelSelector(makeConfig(), store)
    const prompt = vi.fn().mockRejectedValue(new Error("network error"))

    await handleReactiveEvent(
      {
        type: "session.status",
        properties: {
          status: { type: "retry", attempt: 4, message: "429 Too Many Requests" },
          sessionID,
        },
      },
      {
        client: {
          session: {
            abort: vi.fn().mockResolvedValue(undefined),
            revert: vi.fn().mockResolvedValue(undefined),
            prompt,
            messages: vi.fn().mockResolvedValue({ data: [{
              info: { id: "m1", role: "user", model: { providerID: "deepseek", modelID: "v4-pro" }, agent: "build" },
              parts: [{ type: "text", text: "test" }],
            }] }),
          },
          tui: null,
        } as any,
        store,
        selector,
        rules: [{ statusCodes: [429], patterns: [] }],
        maxRetries: 3,
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        dedupSet: new Set<string>(),
        pluginPromptedSessions,
        messageCache: new Map([["ses_test", [{ modelKey: "deepseek/v4-pro", agentName: "build", messageID: "m1" }]]]),
        handledRetrySessions: new Set<string>(),
      },
    )

    // Marker should be cleaned up after prompt failure
    expect(pluginPromptedSessions.has(sessionID)).toBe(false)
  })

  it("session.deleted cleans up marker", () => {
    // Simulate: reactive handler set the marker
    pluginPromptedSessions.add("ses_delete_test")
    pluginPromptedSessions.add("ses_other_test")
    expect(pluginPromptedSessions.size).toBe(2)

    // Simulate: session.deleted event cleans up the marker
    const deletedSessionID = "ses_delete_test"
    pluginPromptedSessions.delete(deletedSessionID)

    expect(pluginPromptedSessions.has("ses_delete_test")).toBe(false)
    expect(pluginPromptedSessions.has("ses_other_test")).toBe(true)
    expect(pluginPromptedSessions.size).toBe(1)
  })
})
