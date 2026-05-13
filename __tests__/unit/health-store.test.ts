import { describe, it, expect, beforeEach } from "vitest"
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

describe("HealthStore", () => {
  let store: HealthStore

  beforeEach(() => {
    store = new HealthStore(makeConfig())
  })

  it("returns 100 for unknown model", () => {
    expect(store.get("unknown/model")).toBe(100)
  })

  it("identifies primary models", () => {
    expect(store.isPrimary("zhipuai/glm-5.1")).toBe(true)
    expect(store.isPrimary("deepseek/v4-pro")).toBe(false)
  })

  it("deducts failure penalty", () => {
    store.recordFailure("deepseek/v4-pro")
    expect(store.get("deepseek/v4-pro")).toBe(80)
  })

  it("does not go below 0", () => {
    store._set("deepseek/v4-pro", { score: 5, lastRecoveryAt: 0 })
    store.recordFailure("deepseek/v4-pro")
    expect(store.get("deepseek/v4-pro")).toBe(0)
  })

  it("restores primary model to 100 on success", () => {
    store._set("zhipuai/glm-5.1", { score: 60, lastRecoveryAt: Date.now() })
    store.recordSuccess("zhipuai/glm-5.1")
    expect(store.get("zhipuai/glm-5.1")).toBe(100)
  })

  it("adds +5 to fallback on success, capped at 100", () => {
    store._set("deepseek/v4-pro", { score: 95, lastRecoveryAt: Date.now() })
    store.recordSuccess("deepseek/v4-pro")
    expect(store.get("deepseek/v4-pro")).toBe(100)
  })

  it("ticks recovery for primary models after interval", () => {
    const past = Date.now() - 2000
    store._set("zhipuai/glm-5.1", { score: 70, lastRecoveryAt: past })
    store.tick()
    expect(store.get("zhipuai/glm-5.1")).toBe(80)
  })

  it("ticks recovery for fallback models after interval", () => {
    const past = Date.now() - 3000
    store._set("deepseek/v4-pro", { score: 70, lastRecoveryAt: past })
    store.tick()
    expect(store.get("deepseek/v4-pro")).toBe(75)
  })

  it("does not tick before interval elapsed", () => {
    const recent = Date.now() - 500
    store._set("zhipuai/glm-5.1", { score: 70, lastRecoveryAt: recent })
    store.tick()
    expect(store.get("zhipuai/glm-5.1")).toBe(70)
  })

  it("skips tick for untouched models (lastRecoveryAt=0)", () => {
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })
    store.tick()
    expect(store.get("zhipuai/glm-5.1")).toBe(100)
  })

  it("sorts by score descending, preserves input order on tie", () => {
    store._set("A", { score: 80, lastRecoveryAt: 0 })
    store._set("B", { score: 100, lastRecoveryAt: 0 })
    store._set("C", { score: 80, lastRecoveryAt: 0 })
    const result = store.sort(["A", "B", "C"])
    expect(result).toEqual(["B", "A", "C"])
  })

  it("stops recovery when score reaches 100", () => {
    const past = Date.now() - 2000
    store._set("zhipuai/glm-5.1", { score: 95, lastRecoveryAt: past })
    store.tick()
    expect(store.get("zhipuai/glm-5.1")).toBe(100)
    const past2 = Date.now() - 5000
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })
    store.tick()
    expect(store.get("zhipuai/glm-5.1")).toBe(100)
  })
})
