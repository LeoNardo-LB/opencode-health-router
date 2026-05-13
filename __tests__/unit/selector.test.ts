import { describe, it, expect, beforeEach } from "vitest"
import { ModelSelector } from "../../src/selection/selector.js"
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
    primaryModels: new Set(),
    logging: { level: "error", path: "" },
  }
}

function makeMultiProviderConfig(): Config {
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
      build: { fallbackModels: ["zhipuai/glm-5.1", "zhipuai/glm-5-turbo", "openai/gpt-4o", "deepseek/v4-pro"] },
      singleProvider: { fallbackModels: ["zhipuai/glm-5.1", "zhipuai/glm-5-turbo"] },
      "*": { fallbackModels: ["openai/gpt-4o"] },
    },
    primaryModels: new Set(),
    logging: { level: "error", path: "" },
  }
}

describe("ModelSelector", () => {
  let selector: ModelSelector
  let health: HealthStore

  beforeEach(() => {
    health = new HealthStore(makeConfig())
    selector = new ModelSelector(makeConfig(), health)
  })

  it("returns first fallback model for known agent", () => {
    const result = selector.resolve("build")
    expect(result).toBe("deepseek/v4-pro")
  })

  it("falls back to wildcard agent", () => {
    const result = selector.resolve("unknown_agent")
    expect(result).toBe("openai/gpt-4o")
  })

  it("returns null when no agent and no wildcard", () => {
    const cfg = { ...makeConfig(), agents: {} }
    const sel = new ModelSelector(cfg, health)
    expect(sel.resolve("build")).toBeNull()
  })

  it("returns highest score model", () => {
    health._set("deepseek/v4-pro", { score: 60, lastRecoveryAt: Date.now() })
    health._set("deepseek/v4-flash", { score: 100, lastRecoveryAt: 0 })
    const result = selector.resolve("build")
    expect(result).toBe("deepseek/v4-flash")
  })

  it("preserves config order on score tie", () => {
    health._set("deepseek/v4-pro", { score: 80, lastRecoveryAt: Date.now() })
    health._set("deepseek/v4-flash", { score: 80, lastRecoveryAt: Date.now() })
    const result = selector.resolve("build")
    expect(result).toBe("deepseek/v4-pro")
  })
})

describe("ModelSelector.excludeProvider", () => {
  let selector: ModelSelector
  let health: HealthStore

  beforeEach(() => {
    health = new HealthStore(makeMultiProviderConfig())
    selector = new ModelSelector(makeMultiProviderConfig(), health)
  })

  it("skips models from excluded provider", () => {
    const result = selector.resolve("build", { excludeProvider: "zhipuai" })
    expect(result).toBe("openai/gpt-4o")
  })

  it("still returns models from other providers", () => {
    const result = selector.resolve("build", { excludeProvider: "deepseek" })
    // zhipuai models should be available
    expect(result).toBe("zhipuai/glm-5.1")
  })

  it("returns null if all models are from excluded provider", () => {
    const result = selector.resolve("singleProvider", { excludeProvider: "zhipuai" })
    expect(result).toBeNull()
  })

  it("ignores excludeProvider when undefined", () => {
    const result = selector.resolve("build", undefined)
    expect(result).toBe("zhipuai/glm-5.1")
  })

  it("ignores excludeProvider when option is empty object", () => {
    const result = selector.resolve("build", {})
    expect(result).toBe("zhipuai/glm-5.1")
  })
})
