import { describe, it, expect, vi } from "vitest"
import { handleReactiveEvent } from "../../src/actions/reactive.js"
import { handleChatMessage } from "../../src/actions/preemptive.js"
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
      plan: { fallbackModels: ["anthropic/claude-4-sonnet"] },
      general: { fallbackModels: ["openai/gpt-4o"] },
      "*": { fallbackModels: ["deepseek/v4-flash"] },
    },
    primaryModels: new Set(["zhipuai/glm-5.1"]),
    logging: { level: "error", path: "" },
  }
}

describe("Multi-Agent Isolation", () => {
  it("build agent degradation does not affect plan agent selection", async () => {
    const store = new HealthStore(makeConfig())
    const selector = new ModelSelector(makeConfig(), store)
    const logger = createLogger({ level: "error" })
    const dedupSet = new Set<string>()
    const pluginPromptedSessions = new Set<string>()

    // Step 1: build agent's primary model fails
    const buildEvent = {
      type: "session.status",
      properties: {
        sessionID: "build-session",
        status: { type: "retry", attempt: 4, message: "429 Rate Limited" },
      },
    }
    await handleReactiveEvent(buildEvent, {
      client: {
        session: {
          abort: vi.fn().mockResolvedValue(true),
          revert: vi.fn().mockResolvedValue({}),
          prompt: vi.fn().mockResolvedValue({}),
          messages: vi.fn().mockResolvedValue({ data: [{
            info: {
              id: "m1",
              role: "user",
              model: { providerID: "zhipuai", modelID: "glm-5.1" },
              agent: "build",
            },
            parts: [{ type: "text", text: "build something" }],
          }] }),
        },
      },
      store, selector, rules: BUILTIN_RULES, maxRetries: 3,
      logger, dedupSet, pluginPromptedSessions,
      messageCache: new Map([["build-session", [{ modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "m1" }]]]),
        handledRetrySessions: new Set<string>(),
    })

    // Verify build agent's primary model score dropped
    expect(store.get("zhipuai/glm-5.1")).toBe(80) // 100 - 20

    // Step 2: plan agent should still select its own fallback chain
    const planResult = selector.resolve("plan")
    expect(planResult).toBe("anthropic/claude-4-sonnet") // plan's own fallback, NOT build's

    // Step 3: general agent should use its own fallback
    const generalResult = selector.resolve("general")
    expect(generalResult).toBe("openai/gpt-4o")

    // Step 4: build agent should use its own fallback
    const buildResult = selector.resolve("build")
    expect(buildResult).toBe("deepseek/v4-pro")
  })

  it("preemptive switching for one agent does not affect another", () => {
    const store = new HealthStore(makeConfig())
    const config = makeConfig()

    // Lower the primary model's score (simulating build failures)
    store._set("zhipuai/glm-5.1", { score: 60, lastRecoveryAt: Date.now() })

    // Build agent: should switch to its fallback
    const buildOutput = { message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } }, parts: [] }
    handleChatMessage(
      { sessionID: "s1", agent: "build", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
      buildOutput,
      store,
      config,
    )
    expect(buildOutput.message.model).toEqual({ providerID: "deepseek", modelID: "v4-pro" })

    // Plan agent: should switch to its OWN fallback, not build's
    const planOutput = { message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } }, parts: [] }
    handleChatMessage(
      { sessionID: "s2", agent: "plan", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
      planOutput,
      store,
      config,
    )
    expect(planOutput.message.model).toEqual({ providerID: "anthropic", modelID: "claude-4-sonnet" })

    // General agent: should switch to its OWN fallback
    const generalOutput = { message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } }, parts: [] }
    handleChatMessage(
      { sessionID: "s3", agent: "general", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
      generalOutput,
      store,
      config,
    )
    expect(generalOutput.message.model).toEqual({ providerID: "openai", modelID: "gpt-4o" })
  })

  it("wildcard agent is isolated from named agents", () => {
    const store = new HealthStore(makeConfig())
    const selector = new ModelSelector(makeConfig(), store)

    // Wildcard agent gets its own fallback
    const wildcardResult = selector.resolve("unknown_agent")
    expect(wildcardResult).toBe("deepseek/v4-flash") // wildcard's fallback, not build/plan/general's

    // Named agents don't use wildcard's fallback
    const buildResult = selector.resolve("build")
    expect(buildResult).toBe("deepseek/v4-pro") // build's own, NOT deepseek/v4-flash
  })
})
