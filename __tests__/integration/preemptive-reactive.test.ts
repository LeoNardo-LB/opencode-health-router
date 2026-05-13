import { describe, it, expect, vi } from "vitest"
import { handleChatMessage } from "../../src/actions/preemptive.js"
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
      build: { fallbackModels: ["deepseek/v4-pro", "deepseek/v4-flash"] },
    },
    primaryModels: new Set(["zhipuai/glm-5.1"]),
    logging: { level: "error", path: "" },
  }
}

describe("Preemptive + Reactive Integration", () => {
  it("preemptive switches after reactive has lowered primary score", async () => {
    const store = new HealthStore(makeConfig())
    const selector = new ModelSelector(makeConfig(), store)
    const logger = createLogger({ level: "error" })
    const dedupSet = new Set<string>()
    const pluginPromptedSessions = new Set<string>()

    // Step 1: Reactive — primary model fails, score drops
    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })
    const reactiveEvent = {
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "retry", attempt: 4, message: "429 Rate Limited" } },
    }
    await handleReactiveEvent(reactiveEvent, {
      client: {
        session: {
          abort: vi.fn().mockResolvedValue(true),
          revert: vi.fn().mockResolvedValue({}),
          prompt: vi.fn().mockResolvedValue({}),
          messages: vi.fn().mockResolvedValue({ data: [{
            info: { id: "m1", role: "user", model: { providerID: "zhipuai", modelID: "glm-5.1" }, agent: "build" },
            parts: [{ type: "text", text: "test" }],
          }] }),
        },
      },
      store, selector, rules: BUILTIN_RULES, maxRetries: 3,
      logger, dedupSet, pluginPromptedSessions,
      messageCache: new Map([["s1", [{ modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "m1" }]]]),
      handledRetrySessions: new Set<string>(),
    })
    expect(store.get("zhipuai/glm-5.1")).toBe(80)

    // Step 2: Preemptive — next message should use deepseek because glm-5.1 is 80
    const output = { message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } }, parts: [] }
    handleChatMessage(
      { sessionID: "s2", agent: "build", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
      output,
      store,
      makeConfig(),
    )
    expect(output.message.model).toEqual({ providerID: "deepseek", modelID: "v4-pro" })
  })
})

describe("Reactive quota_exceeded same-provider filter", () => {
  it("skips all models from the same provider when quota_exceeded occurs", async () => {
    const config: Config = {
      enabled: true,
      classification: { rules: BUILTIN_RULES },
      healthScore: {
        failurePenalty: 20,
        primary: { recoveryIntervalMs: 1_800_000, recoveryBonus: 10, successBehavior: "full" },
        fallback: { recoveryIntervalMs: 3_600_000, recoveryBonus: 5, successBonus: 5 },
      },
      retryPolicy: { maxRetries: 3 },
      agents: {
        build: { fallbackModels: ["zhipuai/glm-5-turbo", "deepseek/v4-pro", "openai/gpt-4o"] },
      },
      primaryModels: new Set(["zhipuai/glm-5.1"]),
      logging: { level: "error", path: "" },
    }

    const store = new HealthStore(config)
    const selector = new ModelSelector(config, store)
    const logger = createLogger({ level: "error" })
    const dedupSet = new Set<string>()
    const pluginPromptedSessions = new Set<string>()
    const promptFn = vi.fn().mockResolvedValue({})

    store._set("zhipuai/glm-5.1", { score: 100, lastRecoveryAt: 0 })

    const reactiveEvent = {
      type: "session.status",
      properties: {
        sessionID: "s1",
        status: { type: "retry", attempt: 4, message: "402 insufficient_quota: Quota exceeded for provider" },
      },
    }

    await handleReactiveEvent(reactiveEvent, {
      client: {
        session: {
          abort: vi.fn().mockResolvedValue(true),
          revert: vi.fn().mockResolvedValue({}),
          prompt: promptFn,
          messages: vi.fn().mockResolvedValue({ data: [{
            info: { id: "m1", role: "user", model: { providerID: "zhipuai", modelID: "glm-5.1" }, agent: "build" },
            parts: [{ type: "text", text: "test" }],
          }] }),
        },
      },
      store, selector, rules: BUILTIN_RULES, maxRetries: 3,
      logger, dedupSet, pluginPromptedSessions,
      messageCache: new Map([["s1", [{ modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "m1" }]]]),
      handledRetrySessions: new Set<string>(),
    })

    // Should have switched to a non-zhipuai model
    expect(promptFn).toHaveBeenCalledOnce()
    const promptCall = promptFn.mock.calls[0][0]
    expect(promptCall.body.model.providerID).not.toBe("zhipuai")
  })
})
