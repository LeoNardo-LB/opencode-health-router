import { describe, it, expect, beforeEach, vi } from "vitest"
import { RetryCounter } from "../../src/retry/counter.js"

describe("RetryCounter", () => {
  let counter: RetryCounter

  beforeEach(() => {
    counter = new RetryCounter(60_000)
  })

  it("returns 1 on first increment", () => {
    expect(counter.increment("zhipuai/glm-5.1")).toBe(1)
  })

  it("increments count for same model", () => {
    counter.increment("zhipuai/glm-5.1")
    expect(counter.increment("zhipuai/glm-5.1")).toBe(2)
    expect(counter.increment("zhipuai/glm-5.1")).toBe(3)
  })

  it("tracks different models independently", () => {
    counter.increment("zhipuai/glm-5.1")
    counter.increment("zhipuai/glm-5.1")
    expect(counter.increment("deepseek/v4-pro")).toBe(1)
    expect(counter.getCount("zhipuai/glm-5.1")).toBe(2)
  })

  it("returns 0 for unknown model", () => {
    expect(counter.getCount("unknown/model")).toBe(0)
  })

  it("resets count on time window expiry", () => {
    const shortCounter = new RetryCounter(100) // 100ms window
    shortCounter.increment("zhipuai/glm-5.1")
    shortCounter.increment("zhipuai/glm-5.1")
    expect(shortCounter.getCount("zhipuai/glm-5.1")).toBe(2)

    // Force time window expiry
    vi.useFakeTimers()
    vi.advanceTimersByTime(150)
    // After window expiry, increment resets to 1
    expect(shortCounter.increment("zhipuai/glm-5.1")).toBe(1)
    vi.useRealTimers()
  })

  it("reset clears count for specific model", () => {
    counter.increment("zhipuai/glm-5.1")
    counter.increment("zhipuai/glm-5.1")
    counter.reset("zhipuai/glm-5.1")
    expect(counter.getCount("zhipuai/glm-5.1")).toBe(0)
    // Next increment starts fresh at 1
    expect(counter.increment("zhipuai/glm-5.1")).toBe(1)
  })

  it("reset does not affect other models", () => {
    counter.increment("zhipuai/glm-5.1")
    counter.increment("deepseek/v4-pro")
    counter.reset("zhipuai/glm-5.1")
    expect(counter.getCount("zhipuai/glm-5.1")).toBe(0)
    expect(counter.getCount("deepseek/v4-pro")).toBe(1)
  })

  it("cleanup removes stale entries", () => {
    const shortCounter = new RetryCounter(100)
    shortCounter.increment("model/a")
    shortCounter.increment("model/b")
    expect(shortCounter.getCount("model/a")).toBe(1)

    vi.useFakeTimers()
    vi.advanceTimersByTime(250) // well past window
    shortCounter.cleanup()
    // After cleanup, stale entries are gone
    expect(shortCounter.getCount("model/a")).toBe(0)
    expect(shortCounter.getCount("model/b")).toBe(0)
    vi.useRealTimers()
  })

  it("cleanup preserves fresh entries", () => {
    counter.increment("model/a")
    counter.cleanup()
    expect(counter.getCount("model/a")).toBe(1)
  })

  it("windowMs defaults to 60000 when not specified", () => {
    const defaultCounter = new RetryCounter()
    defaultCounter.increment("model/a")
    // Should NOT expire within normal time
    expect(defaultCounter.getCount("model/a")).toBe(1)
  })
})
