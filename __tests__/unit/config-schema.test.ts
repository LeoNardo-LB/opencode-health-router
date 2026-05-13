import { describe, it, expect } from "vitest"
import { validate } from "../../src/config/schema.js"

describe("validate", () => {
  it("accepts minimal valid config", () => {
    const { config, warnings } = validate({
      agents: { "*": { fallbackModels: ["deepseek/deepseek-v4-flash"] } },
    })
    expect(config.enabled).toBe(true)
    expect(config.agents["*"].fallbackModels).toEqual(["deepseek/deepseek-v4-flash"])
    expect(warnings.length).toBe(0)
  })

  it("accepts empty object (all defaults)", () => {
    const { config } = validate({})
    expect(config.enabled).toBe(true)
    expect(config.retryPolicy.maxRetries).toBe(3)
  })

  it("reports warnings for invalid fields", () => {
    const { warnings } = validate({ retryPolicy: { maxRetries: 99 } })
    expect(warnings.length).toBeGreaterThan(0)
  })

  it("uses empty classification rules by default (built-in rules in classifier)", () => {
    const { config } = validate({ agents: { build: { fallbackModels: ["a/b"] } } })
    expect(config.classification.rules).toEqual([])
  })
})
