import { describe, it, expect, beforeEach } from "vitest"
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
      fallback: { recoveryIntervalMs: 3_600_000, recoveryBonus: 5, successBonus: 5 },
    },
    retryPolicy: { maxRetries: 3 },
    agents: {
      build: { fallbackModels: ["deepseek/v4-pro", "deepseek/v4-flash"] },
      "*": { fallbackModels: ["openai/gpt-4o"] },
    },
    primaryModels: new Set(["zhipuai/glm-5.1"]),
    logging: { level: "error", path: "" },
  }
}

describe("handleChatMessage (preemptive)", () => {
  it("does not intervene when current model has highest score", () => {
    const store = new HealthStore(makeConfig())
    const output = { message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } }, parts: [] }
    handleChatMessage(
      { sessionID: "s1", agent: "build", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
      output,
      store,
      makeConfig(),
    )
    expect(output.message.model).toEqual({ providerID: "zhipuai", modelID: "glm-5.1" })
  })

  it("switches to highest score model when current is not the best", () => {
    const store = new HealthStore(makeConfig())
    store._set("zhipuai/glm-5.1", { score: 60, lastRecoveryAt: Date.now() })
    store._set("deepseek/v4-pro", { score: 100, lastRecoveryAt: 0 })

    const output = { message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } }, parts: [] }
    handleChatMessage(
      { sessionID: "s1", agent: "build", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
      output,
      store,
      makeConfig(),
    )
    expect(output.message.model).toEqual({ providerID: "deepseek", modelID: "v4-pro" })
  })

  it("does nothing when input has no model", () => {
    const store = new HealthStore(makeConfig())
    const output = { message: {}, parts: [] }
    handleChatMessage({ sessionID: "s1" }, output, store, makeConfig())
    expect(output.message.model).toBeUndefined()
  })

  it("falls back to wildcard agent when agent is null", () => {
    const store = new HealthStore(makeConfig())
    store._set("zhipuai/glm-5.1", { score: 60, lastRecoveryAt: Date.now() })
    store._set("openai/gpt-4o", { score: 100, lastRecoveryAt: 0 })

    const output = { message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } }, parts: [] }
    handleChatMessage(
      { sessionID: "s1", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
      output,
      store,
      makeConfig(),
    )
    expect(output.message.model).toEqual({ providerID: "openai", modelID: "gpt-4o" })
  })
})
