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
      general: { fallbackModels: ["deepseek/v4-pro", "deepseek/v4-flash"] },
    },
    primaryModels: new Set(["zhipuai/glm-5-turbo"]),
    logging: { level: "error", path: "" },
  }
}

/**
 * Simulates the chat.message hook caching logic from index.ts.
 * ALL messages get cached — including plugin-triggered prompts — so that
 * fallback-to-fallback chains have the metadata needed for the next reactive event.
 */
function simulateChatMessageCache(
  messageCache: Map<string, Array<{ modelKey: string; agentName: string; messageID: string }>>,
        
        
  sessionID: string,
  model: { providerID: string; modelID: string },
  agent: string,
  messageID: string,
) {
  const entry = {
    modelKey: `${model.providerID}/${model.modelID}`,
    agentName: agent,
    messageID,
  }
  const stack = messageCache.get(sessionID)
        
  if (stack) {
    stack.push(entry)
  } else {
    messageCache.set(sessionID, [entry])
        
  }
}

describe("Fallback chain — messageCache continuity across fallbacks", () => {
        
  it("caches fallback message and enables second fallback when first fallback also fails", async () => {
    const config = makeConfig()
    const store = new HealthStore(config)
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const dedupSet = new Set<string>()
    const pluginPromptedSessions = new Set<string>()
    const messageCache = new Map<string, Array<{ modelKey: string; agentName: string; messageID: string }>>()
        

    const sessionID = "ses-chain"
    const userMessageID = "msg-user-1"

    // ── Step 1: User sends message → chat.message caches it ──
    simulateChatMessageCache(
      messageCache, sessionID,
        
      { providerID: "zhipuai", modelID: "glm-5-turbo" },
      "general", userMessageID,
    )
    expect(messageCache.get(sessionID)).toEqual([
        
      { modelKey: "zhipuai/glm-5-turbo", agentName: "general", messageID: userMessageID },
    ])

    // ── Step 2: Primary model fails → session.status retry (attempt=4) ──
    const promptFn = vi.fn().mockResolvedValue({ info: { id: "msg-fallback-a" }, parts: [] })

    await handleReactiveEvent(
      {
        type: "session.status",
        properties: {
          sessionID,
          status: { type: "retry", attempt: 4, message: "429 已达到 5 小时的使用上限" },
        },
      },
      {
        client: {
          session: {
            abort: vi.fn().mockResolvedValue(true),
            revert: vi.fn().mockResolvedValue({}),
            prompt: promptFn,
            messages: vi.fn().mockResolvedValue({ data: [{
              info: { id: userMessageID, role: "user", model: { providerID: "zhipuai", modelID: "glm-5-turbo" }, agent: "general" },
              parts: [{ type: "text", text: "Write a test" }],
            }] }),
          },
        },
        store, selector, rules: BUILTIN_RULES, maxRetries: 3,
        logger, dedupSet, pluginPromptedSessions, messageCache,
        handledRetrySessions: new Set<string>(),
        
      },
    )

    // Verify first fallback: prompt called with deepseek/v4-pro
    expect(promptFn).toHaveBeenCalledTimes(1)
    expect(promptFn).toHaveBeenCalledWith({
      path: { id: sessionID },
      body: {
        model: { providerID: "deepseek", modelID: "v4-pro" },
        parts: [{ type: "text", text: "Write a test" }],
      },
    })

    // After reactive splices the consumed entry, messageCache for this session is empty
        
    expect(messageCache.has(sessionID)).toBe(false)
        
    // pluginPromptedSessions is set by reactive handler
    expect(pluginPromptedSessions.has(sessionID)).toBe(true)

    // ── Step 3: Fallback model A's prompt triggers chat.message → cache it ──
    // This is the critical fix: even though pluginPromptedSessions is set,
    // the chat.message hook STILL caches the message metadata.
    simulateChatMessageCache(
      messageCache, sessionID,
        
      { providerID: "deepseek", modelID: "v4-pro" },
      "general", userMessageID,
    )
    expect(messageCache.get(sessionID)).toEqual([
        
      { modelKey: "deepseek/v4-pro", agentName: "general", messageID: userMessageID },
    ])

    // ── Step 4: Fallback model A also fails → session.status retry (attempt=7) ──
    await handleReactiveEvent(
      {
        type: "session.status",
        properties: {
          sessionID,
          status: { type: "retry", attempt: 7, message: "429 Rate limit exceeded for deepseek" },
        },
      },
      {
        client: {
          session: {
            abort: vi.fn().mockResolvedValue(true),
            revert: vi.fn().mockResolvedValue({}),
            prompt: promptFn,
            messages: vi.fn().mockResolvedValue({ data: [{
              info: { id: userMessageID, role: "user", model: { providerID: "deepseek", modelID: "v4-pro" }, agent: "general" },
              parts: [{ type: "text", text: "Write a test" }],
            }] }),
          },
        },
        store, selector, rules: BUILTIN_RULES, maxRetries: 3,
        logger, dedupSet, pluginPromptedSessions, messageCache,
        handledRetrySessions: new Set<string>(),
        
      },
    )

    // Verify second fallback: prompt called with deepseek/v4-flash
    expect(promptFn).toHaveBeenCalledTimes(2)
    expect(promptFn).toHaveBeenNthCalledWith(2, {
      path: { id: sessionID },
      body: {
        model: { providerID: "deepseek", modelID: "v4-flash" },
        parts: [{ type: "text", text: "Write a test" }],
      },
    })

    // After both entries consumed, messageCache for this session is empty again
        
    expect(messageCache.has(sessionID)).toBe(false)
        

    // Health scores reflect failures
    expect(store.get("zhipuai/glm-5-turbo")).toBe(80)  // 100 - 20
    expect(store.get("deepseek/v4-pro")).toBe(80)       // 100 - 20
  })

  it("would have FAILED before fix: no_cache_match when cache is empty", async () => {
    const config = makeConfig()
    const store = new HealthStore(config)
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const dedupSet = new Set<string>()
    const pluginPromptedSessions = new Set<string>()
    const messageCache = new Map<string, Array<{ modelKey: string; agentName: string; messageID: string }>>()
        

    const sessionID = "ses-chain-bug"
    const userMessageID = "msg-user-1"

    // ── Step 1: User sends message → cache it ──
    simulateChatMessageCache(
      messageCache, sessionID,
        
      { providerID: "zhipuai", modelID: "glm-5-turbo" },
      "general", userMessageID,
    )

    // ── Step 2: Primary fails → reactive → prompt to fallback A ──
    const promptFn = vi.fn().mockResolvedValue({ info: { id: "msg-fallback-a" }, parts: [] })

    await handleReactiveEvent(
      {
        type: "session.status",
        properties: {
          sessionID,
          status: { type: "retry", attempt: 4, message: "429 已达到 5 小时的使用上限" },
        },
      },
      {
        client: {
          session: {
            abort: vi.fn().mockResolvedValue(true),
            revert: vi.fn().mockResolvedValue({}),
            prompt: promptFn,
            messages: vi.fn().mockResolvedValue({ data: [{
              info: { id: userMessageID, role: "user", model: { providerID: "zhipuai", modelID: "glm-5-turbo" }, agent: "general" },
              parts: [{ type: "text", text: "Write a test" }],
            }] }),
          },
        },
        store, selector, rules: BUILTIN_RULES, maxRetries: 3,
        logger, dedupSet, pluginPromptedSessions, messageCache,
        handledRetrySessions: new Set<string>(),
        
      },
    )

    // First fallback works fine
    expect(promptFn).toHaveBeenCalledTimes(1)
    expect(promptFn).toHaveBeenCalledWith({
      path: { id: sessionID },
      body: {
        model: { providerID: "deepseek", modelID: "v4-pro" },
        parts: [{ type: "text", text: "Write a test" }],
      },
    })

    // After reactive consumed the entry, messageCache is empty
        
    expect(messageCache.has(sessionID)).toBe(false)
        

    // ── Step 3: DON'T cache fallback A's message (simulating old behavior) ──
    // Before the fix, chat.message returned early when pluginPromptedSessions was set,
    // so the fallback message was never cached.

    // ── Step 4: Fallback A also fails → reactive → no_cache_match (stackSize=0) ──
    await handleReactiveEvent(
      {
        type: "session.status",
        properties: {
          sessionID,
          status: { type: "retry", attempt: 7, message: "429 Rate limit exceeded for deepseek" },
        },
      },
      {
        client: {
          session: {
            abort: vi.fn().mockResolvedValue(true),
            revert: vi.fn().mockResolvedValue({}),
            prompt: promptFn,
            messages: vi.fn().mockResolvedValue({ data: [{
              info: { id: userMessageID, role: "user", model: { providerID: "deepseek", modelID: "v4-pro" }, agent: "general" },
              parts: [{ type: "text", text: "Write a test" }],
            }] }),
          },
        },
        store, selector, rules: BUILTIN_RULES, maxRetries: 3,
        logger, dedupSet, pluginPromptedSessions, messageCache,
        handledRetrySessions: new Set<string>(),
        
      },
    )

    // Without the cache entry, reactive hits no_cache_match and returns early.
    // prompt was NOT called a second time — the chain is broken.
    expect(promptFn).toHaveBeenCalledTimes(1)
  })
})
