import { describe, it, expect } from "vitest"
import { HealthStore } from "../../src/health/store.js"
import type { Config } from "../../src/types.js"

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    classification: { rules: [] },
    healthScore: {
      failurePenalty: 20,
      primary: { recoveryIntervalMs: 1000, recoveryBonus: 10, successBehavior: "full" },
      fallback: { recoveryIntervalMs: 2000, recoveryBonus: 5, successBonus: 5 },
    },
    retryPolicy: { maxRetries: 3 },
    agents: { "*": { fallbackModels: [] } },
    primaryModels: new Set(["zhipuai/glm-5.1"]),
    logging: { level: "error", path: "" },
    ...overrides,
  }
}

describe("Health Score Evolution", () => {
  it("simulates 10 interactions with score accumulation and recovery", () => {
    const store = new HealthStore(makeConfig())

    // Interaction 1-3: primary fails 3 times
    for (let i = 0; i < 3; i++) {
      store.recordFailure("zhipuai/glm-5.1")
    }
    expect(store.get("zhipuai/glm-5.1")).toBe(40)

    // Interaction 4-5: fallback succeeds, gains score
    store.recordSuccess("deepseek/v4-pro")
    expect(store.get("deepseek/v4-pro")).toBe(100)

    // Advance time 2 seconds (beyond primary recovery interval)
    store._set("zhipuai/glm-5.1", { score: 40, lastRecoveryAt: Date.now() - 2000 })
    store.tick()
    expect(store.get("zhipuai/glm-5.1")).toBe(50)

    // Advance more time
    store._set("zhipuai/glm-5.1", { score: 50, lastRecoveryAt: Date.now() - 2000 })
    store.tick()
    expect(store.get("zhipuai/glm-5.1")).toBe(60)

    // Primary succeeds → full restore
    store.recordSuccess("zhipuai/glm-5.1")
    expect(store.get("zhipuai/glm-5.1")).toBe(100)
  })
})
