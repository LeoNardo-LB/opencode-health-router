import { describe, it, expect } from "vitest"
import { parseJSONC } from "../../src/jsonc.js"

describe("parseJSONC", () => {
  it("parses normal JSON", () => {
    expect(parseJSONC('{"a":1}')).toEqual({ a: 1 })
  })

  it("strips single-line comments", () => {
    expect(parseJSONC('{"a":1}//comment')).toEqual({ a: 1 })
  })

  it("strips multi-line comments", () => {
    expect(parseJSONC('{"a":1}/*comment*/')).toEqual({ a: 1 })
  })

  it("strips BOM header", () => {
    expect(parseJSONC('\uFEFF{"a":1}')).toEqual({ a: 1 })
  })

  it("removes trailing comma in object", () => {
    expect(parseJSONC('{"a":1,}')).toEqual({ a: 1 })
  })

  it("removes trailing comma in array", () => {
    expect(parseJSONC('[1,]')).toEqual([1])
  })

  it("does not merge adjacent tokens when comment is between them", () => {
    // 1/*c*/3 should NOT become 13 — spaces replace comment
    expect(() => parseJSONC("1/*c*/3")).toThrow()
  })

  it("preserves comments inside strings", () => {
    expect(parseJSONC('{"url":"//not comment"}')).toEqual({ url: "//not comment" })
  })

  it("handles escaped quotes in strings", () => {
    expect(parseJSONC('"hello\\"world"')).toBe('hello"world')
  })

  it("throws on invalid JSONC", () => {
    expect(() => parseJSONC("{invalid}")).toThrow()
  })

  it("throws on single-quoted strings", () => {
    expect(() => parseJSONC("{'a':1}")).toThrow()
  })

  it("throws on empty string", () => {
    expect(() => parseJSONC("")).toThrow()
  })

  it("parses complex nested JSONC with mixed comments", () => {
    const input = `{
  // top-level comment
  "name": "test", /* inline block */
  "items": [
    // first item
    "a",
    "b", // second item
    "c"
  ],
  "nested": { /* nested block */ "key": 123, }
}`
    const result = parseJSONC(input)
    expect(result).toEqual({
      name: "test",
      items: ["a", "b", "c"],
      nested: { key: 123 },
    })
  })
})
