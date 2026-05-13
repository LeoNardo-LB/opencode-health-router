import { describe, it, expect } from "vitest"
import { shouldIntervene } from "../../src/retry/policy.js"

describe("shouldIntervene", () => {
  it("returns false when attempt <= maxRetries (let OpenCode retry)", () => {
    expect(shouldIntervene(1, 3)).toBe(false)
    expect(shouldIntervene(2, 3)).toBe(false)
    expect(shouldIntervene(3, 3)).toBe(false)
  })

  it("returns true when attempt > maxRetries (plugin intervenes)", () => {
    expect(shouldIntervene(4, 3)).toBe(true)
  })

  it("returns true on 2nd attempt when maxRetries is 1", () => {
    expect(shouldIntervene(1, 1)).toBe(false)
    expect(shouldIntervene(2, 1)).toBe(true)
  })
})
