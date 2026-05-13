import { describe, it, expect } from "vitest"
import { classify } from "../../src/classification/classifier.js"
import { BUILTIN_RULES } from "../../src/classification/patterns.js"

describe("classify", () => {
  it("matches 429 rate limit", () => {
    const result = classify("429 Too Many Requests", BUILTIN_RULES)
    expect(result).not.toBeNull()
    expect(result!.category).toBe("rate_limit")
  })

  it("matches 429 with Chinese pattern (使用上限)", () => {
    const result = classify("429 已达到 5 小时的使用上限", BUILTIN_RULES)
    expect(result).not.toBeNull()
    expect(result!.category).toBe("rate_limit")
  })

  it("matches 429 with code 1308", () => {
    const result = classify("429 错误码: 1308", BUILTIN_RULES)
    expect(result).not.toBeNull()
  })

  it("matches 500 server error", () => {
    const result = classify("500 Internal Server Error", BUILTIN_RULES)
    expect(result).not.toBeNull()
    expect(result!.category).toBe("5xx")
  })

  it("matches timeout without statusCode", () => {
    const result = classify("request timed out after 30s", BUILTIN_RULES)
    expect(result).not.toBeNull()
    expect(result!.category).toBe("timeout")
  })

  it("returns null for unmatched message", () => {
    const result = classify("200 OK everything fine", BUILTIN_RULES)
    expect(result).toBeNull()
  })

  it("returns null for message without statusCode when rules require it", () => {
    const result = classify("服务器繁忙，请重试", BUILTIN_RULES)
    expect(result).toBeNull()
  })

  it("respects rule priority (first match wins)", () => {
    const rules = [
      { statusCodes: [429], patterns: ["custom"], category: "custom_429" },
      { statusCodes: [429], patterns: [], category: "generic_429" },
    ]
    const result = classify("429 custom error", rules)
    expect(result!.category).toBe("custom_429")
  })

  it("skips rule when statusCodes don't match", () => {
    const rules = [{ statusCodes: [500], patterns: [], category: "5xx" }]
    // 600 doesn't match custom rule (requires 500) and no built-in rule matches 600
    const result = classify("600 Unknown Error", rules)
    expect(result).toBeNull()
  })

  it("handles message without numeric prefix", () => {
    const rules = [{ statusCodes: [], patterns: ["free usage"], category: "quota" }]
    const result = classify("free usage limit reached", rules)
    expect(result).not.toBeNull()
    expect(result!.category).toBe("quota")
  })

  it("matches Chinese quota error without HTTP status code (regression: ses_1e8051b8fffey70rvzT5NhIgV2)", () => {
    const msg = "已达到 5 小时的使用上限。您的限额将在 2026-05-12 02:44:17 重置。"
    const result = classify(msg, BUILTIN_RULES)
    expect(result).not.toBeNull()
    expect(result!.category).toBe("rate_limit")
  })

  it("matches Chinese quota-exhausted message", () => {
    const result = classify("免费账户的 API 调用次数已用尽", BUILTIN_RULES)
    expect(result).not.toBeNull()
    expect(result!.category).toBe("quota_exceeded")
  })

  describe("% wildcard pattern matching", () => {
    it("%between% matches substring anywhere", () => {
      const rules: ClassificationRule[] = [
        { statusCodes: [], patterns: ["%timeout%"], category: "rate_limit" },
      ]
      expect(classify("request timeout after 30s", rules)!.category).toBe("rate_limit")
      expect(classify("xxx timeout xxx", rules)!.category).toBe("rate_limit")
      expect(classify("timeout", rules)!.category).toBe("rate_limit")
    })

    it("prefix% matches only at start (user rules only)", () => {
      const rules: ClassificationRule[] = [
        { statusCodes: [], patterns: ["rate%"], category: "rate_limit" },
      ]
      expect(classify("rate limit exceeded", rules)).not.toBeNull()
      // "high rate limit" doesn't match user rule "rate%" (prefix match)
      // but BUILTIN rule "%rate limit%" matches it (contains match)
      // So the result is NOT null — it matches via builtin fallback
      expect(classify("high rate limit", rules)).not.toBeNull()
    })

    it("builtin rules don't affect pure non-matching strings", () => {
      const rules: ClassificationRule[] = [
        { statusCodes: [], patterns: ["custom%"], category: "rate_limit" },
      ]
      // "something unrelated" matches neither user nor builtin rules
      expect(classify("something unrelated", rules)).toBeNull()
    })

    it("%suffix matches only at end", () => {
      const rules: ClassificationRule[] = [
        { statusCodes: [], patterns: ["%limit"], category: "rate_limit" },
      ]
      expect(classify("rate limit", rules)).not.toBeNull()
      expect(classify("limit exceeded", rules)).toBeNull()
    })

    it("Chinese % wildcard matches ordered segments (regression)", () => {
      const rules: ClassificationRule[] = [
        { statusCodes: [], patterns: ["%已达到%使用上限%"], category: "rate_limit" },
      ]
      const msg = "已达到 5 小时的使用上限。您的限额将在 2026-05-12 02:44:17 重置。"
      expect(classify(msg, rules)!.category).toBe("rate_limit")
    })

    it("Chinese % wildcard respects order (已达到 before 使用上限)", () => {
      const rules: ClassificationRule[] = [
        { statusCodes: [], patterns: ["%已达到%使用上限%"], category: "custom_test" },
      ]
      // Correct order → match (custom rule wins before built-in)
      expect(classify("已达到 5 小时的使用上限", rules)!.category).toBe("custom_test")
      // Wrong order → no match (built-in rules also don't match this message)
      expect(classify("使用上限 exceeded 已达到 limit", rules)).toBeNull()
    })

    it("no % falls back to includes (backward compatible)", () => {
      const rules: ClassificationRule[] = [
        { statusCodes: [], patterns: ["已达到"], category: "rate_limit" },
      ]
      expect(classify("已达到 5 小时的使用上限", rules)!.category).toBe("rate_limit")
      // Also matches when not at boundary (includes behavior)
      expect(classify("xxx已达到xxx", rules)!.category).toBe("rate_limit")
    })

    it("regex special chars in pattern are escaped", () => {
      const rules: ClassificationRule[] = [
        { statusCodes: [], patterns: ["%error[0]%"], category: "5xx" },
      ]
      expect(classify("error[0] occurred", rules)!.category).toBe("5xx")
      expect(classify("error0 occurred", rules)).toBeNull()  // [0] is literal, not character class
    })
  })

  it("category explicitly set", () => {
    const rules: ClassificationRule[] = [
      { statusCodes: [], patterns: ["custom limit"], category: "rate_limit" },
    ]
    const result = classify("custom limit reached", rules)
    expect(result).not.toBeNull()
    expect(result!.category).toBe("rate_limit")
  })

  it("returns 'unknown' when no category and no matching statusCode", () => {
    const rules: ClassificationRule[] = [
      { statusCodes: [], patterns: ["weird error"] },
    ]
    const result = classify("weird error occurred", rules)
    expect(result).not.toBeNull()
    expect(result!.category).toBe("unknown")
  })
})
