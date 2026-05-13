import { describe, it, expect, vi } from "vitest"
import { handleReactiveEvent } from "../../src/actions/reactive.js"
import { HealthStore } from "../../src/health/store.js"
import { ModelSelector } from "../../src/selection/selector.js"
import { createLogger } from "../../src/logging/logger.js"
import { BUILTIN_RULES } from "../../src/classification/patterns.js"
import type { Config } from "../../src/types.js"

function makeConfig(): Config {
  return {
    enabled: true,
    classification: { rules: BUILTIN_RULES },
    healthScore: {
      failurePenalty: 20,
      primary: { recoveryIntervalMs: 1_800_000, recoveryBonus: 10, successBehavior: "full" },
      fallback: { recoveryIntervalMs: 3_600_000, recoveryBonus: 5, successBonus: 5 },
    },
    retryPolicy: { maxRetries: 3 },
    agents: {
      build: { fallbackModels: ["deepseek/v4-pro"] },
    },
    primaryModels: new Set(["zhipuai/glm-5.1"]),
    logging: { level: "error", path: "" },
  }
}

describe("Concurrent message handling", () => {
  it("second message's retry does not use first message's cache entry", async () => {
    // Scenario: user sends msg-A, then msg-B. Both are in cache stack.
    // msg-B fails and triggers retry. Reactive should find msg-B's entry, not msg-A's.
    const config: Config = {
      ...makeConfig(),
      agents: {
        build: { fallbackModels: ["deepseek/v4-pro", "deepseek/v4-flash"] },
      },
    }
    const store = new HealthStore(config)
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const dedupSet = new Set<string>()
    const pluginPromptedSessions = new Set<string>()

    const promptFn = vi.fn().mockResolvedValue({})
    const abortFn = vi.fn().mockResolvedValue({})
    const revertFn = vi.fn().mockResolvedValue({})

    // Cache has TWO entries for session "s1": msg-A and msg-B
    const messageCache = new Map<string, Array<{ modelKey: string; agentName: string; messageID: string }>>([
        
      ["s1", [
        { modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "msg-A" },
        { modelKey: "deepseek/v4-pro", agentName: "build", messageID: "msg-B" },
      ]],
    ])

    // Messages API returns msg-B as the last user message
    const messagesFn = vi.fn().mockResolvedValue({ data: [
      { info: { id: "msg-A", role: "user", model: { providerID: "zhipuai", modelID: "glm-5.1" } }, parts: [{ type: "text", text: "first" }] },
      { info: { id: "msg-B", role: "user", model: { providerID: "deepseek", modelID: "v4-pro" } }, parts: [{ type: "text", text: "second" }] },
    ] })

    const event = {
      type: "session.status",
      properties: {
        sessionID: "s1",
        status: { type: "retry", attempt: 4, message: "429 Too Many Requests" },
      },
    }

    await handleReactiveEvent(event, {
      client: {
        session: { abort: abortFn, revert: revertFn, prompt: promptFn, messages: messagesFn },
      },
      store, selector, rules: BUILTIN_RULES, maxRetries: 3,
      logger, dedupSet, pluginPromptedSessions, messageCache,
        handledRetrySessions: new Set<string>(),
        
    })

    // Should have reverted to msg-B (the last user message), NOT msg-A
    expect(revertFn).toHaveBeenCalledWith({
      path: { id: "s1" },
      body: { messageID: "msg-B" },
    })

    // Should have recorded failure for the model associated with msg-B (deepseek/v4-pro)
    expect(store.get("deepseek/v4-pro")).toBe(80) // 100 - 20

    // Prompt should be called with a DIFFERENT model (not deepseek/v4-pro which failed)
    expect(promptFn).toHaveBeenCalledWith({
      path: { id: "s1" },
      body: {
        model: { providerID: "deepseek", modelID: "v4-flash" },
        parts: [{ type: "text", text: "second" }],
      },
    })

    // msg-B's entry should be removed from stack, msg-A's entry should remain
    const remaining = messageCache.get("s1")
        
    expect(remaining).toBeDefined()
    expect(remaining!.length).toBe(1)
    expect(remaining![0].messageID).toBe("msg-A")
  })

  it("dedup does not collide across different messages in same session", async () => {
    // Scenario: msg-A at attempt=4 triggers reactive (dedup: s1:msg-A:4).
    // Then msg-B at attempt=4 should NOT be blocked by msg-A's dedup entry.
    const config = makeConfig()
    const store = new HealthStore(config)
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const dedupSet = new Set<string>()
    const pluginPromptedSessions = new Set<string>()

    // Pre-populate dedup with msg-A's entry
    dedupSet.add("s1:msg-A:4")

    const promptFn = vi.fn().mockResolvedValue({})
    const abortFn = vi.fn().mockResolvedValue({})
    const revertFn = vi.fn().mockResolvedValue({})

    const messageCache = new Map<string, Array<{ modelKey: string; agentName: string; messageID: string }>>([
        
      ["s1", [
        { modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "msg-B" },
      ]],
    ])

    const messagesFn = vi.fn().mockResolvedValue({ data: [
      { info: { id: "msg-B", role: "user", model: { providerID: "zhipuai", modelID: "glm-5.1" } }, parts: [{ type: "text", text: "hello" }] },
    ] })

    const event = {
      type: "session.status",
      properties: {
        sessionID: "s1",
        status: { type: "retry", attempt: 4, message: "429 Too Many Requests" },
      },
    }

    await handleReactiveEvent(event, {
      client: {
        session: { abort: abortFn, revert: revertFn, prompt: promptFn, messages: messagesFn },
      },
      store, selector, rules: BUILTIN_RULES, maxRetries: 3,
      logger, dedupSet, pluginPromptedSessions, messageCache,
        handledRetrySessions: new Set<string>(),
        
    })

    // msg-B should NOT be blocked by msg-A's dedup
    expect(abortFn).toHaveBeenCalled()
    expect(promptFn).toHaveBeenCalled()

    // New dedup key should be s1:msg-B:4
    expect(dedupSet.has("s1:msg-B:4")).toBe(true)
    // msg-A's dedup entry still exists
    expect(dedupSet.has("s1:msg-A:4")).toBe(true)
  })

  it("returns gracefully when cache has no matching messageID", async () => {
    const config = makeConfig()
    const store = new HealthStore(config)
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const dedupSet = new Set<string>()
    const pluginPromptedSessions = new Set<string>()

    const abortFn = vi.fn()

    // Cache has msg-A, but messages API returns msg-B (different messageID)
    const messageCache = new Map<string, Array<{ modelKey: string; agentName: string; messageID: string }>>([
        
      ["s1", [
        { modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "msg-A" },
      ]],
    ])

    const messagesFn = vi.fn().mockResolvedValue({ data: [
      { info: { id: "msg-B", role: "user", model: { providerID: "zhipuai", modelID: "glm-5.1" } }, parts: [{ type: "text", text: "hello" }] },
    ] })

    const event = {
      type: "session.status",
      properties: {
        sessionID: "s1",
        status: { type: "retry", attempt: 4, message: "429 Too Many Requests" },
      },
    }

    await handleReactiveEvent(event, {
      client: {
        session: { abort: abortFn, revert: vi.fn(), prompt: vi.fn(), messages: messagesFn },
      },
      store, selector, rules: BUILTIN_RULES, maxRetries: 3,
      logger, dedupSet, pluginPromptedSessions, messageCache,
        handledRetrySessions: new Set<string>(),
        
    })

    // Should NOT abort/revert/prompt — no matching cache entry
    expect(abortFn).not.toHaveBeenCalled()
  })

  it("stack cleanup removes empty arrays from messageCache", async () => {
        
    const config = makeConfig()
    const store = new HealthStore(config)
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const dedupSet = new Set<string>()
    const pluginPromptedSessions = new Set<string>()

    const promptFn = vi.fn().mockResolvedValue({})
    const abortFn = vi.fn().mockResolvedValue({})
    const revertFn = vi.fn().mockResolvedValue({})

    // Only ONE entry in stack — after consumption, stack should be deleted
    const messageCache = new Map<string, Array<{ modelKey: string; agentName: string; messageID: string }>>([
        
      ["s1", [
        { modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "msg-X" },
      ]],
    ])

    const messagesFn = vi.fn().mockResolvedValue({ data: [
      { info: { id: "msg-X", role: "user", model: { providerID: "zhipuai", modelID: "glm-5.1" } }, parts: [{ type: "text", text: "hello" }] },
    ] })

    const event = {
      type: "session.status",
      properties: {
        sessionID: "s1",
        status: { type: "retry", attempt: 4, message: "429 Too Many Requests" },
      },
    }

    await handleReactiveEvent(event, {
      client: {
        session: { abort: abortFn, revert: revertFn, prompt: promptFn, messages: messagesFn },
      },
      store, selector, rules: BUILTIN_RULES, maxRetries: 3,
      logger, dedupSet, pluginPromptedSessions, messageCache,
        handledRetrySessions: new Set<string>(),
        
    })

    // After consuming the only entry, the entire key should be removed
    expect(messageCache.has("s1")).toBe(false)
        
    // But the handler should have completed successfully
    expect(abortFn).toHaveBeenCalled()
  })
})
