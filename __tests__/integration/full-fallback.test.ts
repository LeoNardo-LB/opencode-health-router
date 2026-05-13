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
      build: { fallbackModels: ["deepseek/v4-pro", "deepseek/v4-flash"] },
    },
    primaryModels: new Set(["zhipuai/glm-5.1"]),
    logging: { level: "error", path: "" },
  }
}

describe("Full Fallback Integration", () => {
  it("executes abort→revert→prompt on rate limit after max retries", async () => {
    const store = new HealthStore(makeConfig())
    const selector = new ModelSelector(makeConfig(), store)
    const logger = createLogger({ level: "error" })
    const dedupSet = new Set<string>()
    const pluginPromptedSessions = new Set<string>()

    const abort = vi.fn().mockResolvedValue(true)
    const revert = vi.fn().mockResolvedValue({})
    const prompt = vi.fn().mockResolvedValue({ info: { id: "msg-2" }, parts: [] })
    const messages = vi.fn().mockResolvedValue({ data: [{
      info: { id: "msg-1", role: "user", model: { providerID: "zhipuai", modelID: "glm-5.1" }, agent: "build" },
      parts: [{ type: "text", text: "test" }],
    }] })
    const toast = vi.fn().mockResolvedValue(true)

    const event = {
      type: "session.status",
      properties: {
        sessionID: "ses-1",
        status: { type: "retry", attempt: 4, message: "429 已达到 5 小时的使用上限" },
      },
    }

    await handleReactiveEvent(event, {
      client: { session: { abort, revert, prompt, messages }, tui: { showToast: toast } },
      store, selector, rules: BUILTIN_RULES, maxRetries: 3,
      logger, dedupSet, pluginPromptedSessions,
      messageCache: new Map([["ses-1", [{ modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "msg-1" }]]]),
      handledRetrySessions: new Set<string>(),
    })

    expect(abort).toHaveBeenCalledWith({ path: { id: "ses-1" } })
    expect(revert).toHaveBeenCalledWith({ path: { id: "ses-1" }, body: { messageID: "msg-1" } })
    expect(prompt).toHaveBeenCalledWith({
      path: { id: "ses-1" },
      body: { model: { providerID: "deepseek", modelID: "v4-pro" }, parts: [{ type: "text", text: "test" }] },
    })
    expect(toast).toHaveBeenCalled()
  })

  it("does not intervene when attempt <= maxRetries", async () => {
    const store = new HealthStore(makeConfig())
    const selector = new ModelSelector(makeConfig(), store)
    const logger = createLogger({ level: "error" })
    const dedupSet = new Set<string>()
    const pluginPromptedSessions = new Set<string>()
    const abort = vi.fn()

    const event = {
      type: "session.status",
      properties: { sessionID: "ses-2", status: { type: "retry", attempt: 1, message: "429" } },
    }

    await handleReactiveEvent(event, {
      client: { session: { abort, revert: vi.fn(), prompt: vi.fn(), messages: vi.fn() } },
      store, selector, rules: BUILTIN_RULES, maxRetries: 3,
      logger, dedupSet, pluginPromptedSessions,
      messageCache: new Map([["ses-2", [{ modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "m2" }]]]),
      handledRetrySessions: new Set<string>(),
    })

    expect(abort).not.toHaveBeenCalled()
  })
})
