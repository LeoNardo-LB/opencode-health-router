import { describe, it, expect } from "vitest"
import { splitModelKey } from "../../src/types.js"

describe("splitModelKey", () => {
  it("splits provider and model ID", () => {
    const result = splitModelKey("zhipuai/glm-5.1")
    expect(result.providerID).toBe("zhipuai")
    expect(result.modelID).toBe("glm-5.1")
  })

  it("handles deep provider path (multiple slashes)", () => {
    const result = splitModelKey("org/team/model-name")
    expect(result.providerID).toBe("org/team")
    expect(result.modelID).toBe("model-name")
  })

  it("throws when key has no slash", () => {
    expect(() => splitModelKey("nodelash")).toThrow("Invalid ModelKey: nodelash")
  })

  it("throws on empty string", () => {
    expect(() => splitModelKey("")).toThrow("Invalid ModelKey: ")
  })
})
