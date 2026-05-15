import { describe, it, expect, vi } from "vitest"
import { HealthStore } from "../../src/health/store.js"
import { ModelSelector } from "../../src/selection/selector.js"
import { handleReactiveEvent } from "../../src/actions/reactive.js"
import { classify } from "../../src/classification/classifier.js"
import { BUILTIN_RULES } from "../../src/classification/patterns.js"
import { shouldIntervene } from "../../src/retry/policy.js"
import { RetryCounter } from "../../src/retry/counter.js"
import { createLogger } from "../../src/logging/logger.js"
import type { Config } from "../../src/types.js"

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    classification: { rules: BUILTIN_RULES },
    healthScore: {
      failurePenalty: 20,
      primary: { recoveryIntervalMs: 60_000, recoveryBonus: 10, successBehavior: "full" },
      fallback: { recoveryIntervalMs: 120_000, recoveryBonus: 5, successBonus: 5 },
    },
    retryPolicy: { maxRetries: 3 },
    agents: {
      build: { fallbackModels: ["deepseek/v4-pro", "deepseek/v4-flash"] },
      plan: { fallbackModels: ["deepseek/v4-pro"] },
      "*": { fallbackModels: ["deepseek/v4-flash"] },
    },
    primaryModels: new Set(["zhipuai/glm-5.1", "zhipuai/glm-5-turbo"]),
    logging: { level: "debug", path: "" },
    ...overrides,
  }
}

function mockClient(promptResult: "success" | "error" = "success") {
  return {
    session: {
      abort: vi.fn().mockResolvedValue(undefined),
      revert: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockImplementation(() =>
        promptResult === "success"
          ? Promise.resolve({ info: { id: "msg-reply" }, parts: [] })
          : Promise.reject(new Error("prompt failed")),
      ),
      messages: vi.fn().mockResolvedValue({
        data: [
          {
            info: {
              id: "msg-user-default",
              role: "user",
              model: { providerID: "zhipuai", modelID: "glm-5.1" },
              agent: "build",
            },
            parts: [{ type: "text", text: "test message" }],
          },
        ],
      }),
    },
    tui: { showToast: vi.fn().mockResolvedValue(true) },
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("C: 错误分类与边界", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // C1: Quota Exceeded — 排除同 Provider
  // 配额耗尽时排除同厂商所有模型
  // ─────────────────────────────────────────────────────────────────────────
  describe("C1: Quota Exceeded — 排除同 Provider", () => {
    it("配额耗尽时排除同厂商所有模型，切换到其他 Provider 的 fallback", async () => {
      // Step 1: 配置 build agent 的 fallback 模型来自不同 Provider
      const config = makeConfig({
        agents: {
          build: { fallbackModels: ["deepseek/v4-pro", "zhipuai/glm-4.7"] },
          "*": { fallbackModels: [] },
        },
      })
      const store = new HealthStore(config)
      const selector = new ModelSelector(config, store)
      const dedupSet = new Set<string>()
      const pluginPromptedSessions = new Set<string>()
      const handledRetrySessions = new Set<string>()
      const messageCache = new Map<
        string,
        Array<{ modelKey: string; agentName: string; messageID: string }>
      >()
      const logger = createLogger({ level: "debug" })

      // Step 2: 主模型 deepseek/v4-pro — 在 cache 中记录
      messageCache.set("ses-c1", [
        {
          modelKey: "deepseek/v4-pro",
          agentName: "build",
          messageID: "msg-c1-user",
        },
      ])

      const client = mockClient("success")
      client.session.messages = vi.fn().mockResolvedValue({
        data: [
          {
            info: {
              id: "msg-c1-user",
              role: "user",
              model: { providerID: "deepseek", modelID: "v4-pro" },
              agent: "build",
            },
            parts: [{ type: "text", text: "write hello world" }],
          },
        ],
      })

      // 监视 selector.resolve 以捕获 excludeProvider 参数
      const resolveSpy = vi.spyOn(selector, "resolve")

      // 记录初始分数
      const initialScore = store.get("deepseek/v4-pro") // 100

      const errorMessage = "402 配额已用尽"

      // 断言 4: 错误分类为 quota_exceeded
      const classification = classify(errorMessage, config.classification.rules)
      expect(classification).not.toBeNull()
      expect(classification!.category).toBe("quota_exceeded")

      // Step 3: session.status retry (attempt=4)
      await handleReactiveEvent(
        {
          type: "session.status",
          properties: {
            sessionID: "ses-c1",
            status: { type: "retry", attempt: 4, message: errorMessage },
          },
        } as any,
        {
          client: client as any,
          store,
          selector,
          rules: config.classification.rules,
          maxRetries: 3,
          logger,
          dedupSet,
          pluginPromptedSessions,
          messageCache,
          handledRetrySessions,
        },
      )

      // 断言 5: selector.resolve() 被调用时 excludeProvider = "deepseek"
      expect(resolveSpy).toHaveBeenCalledWith("build", { excludeProvider: "deepseek" })

      // 断言 6: 最终 prompt 的模型不是 deepseek/*，应该是 zhipuai/glm-4.7
      expect(client.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            model: { providerID: "zhipuai", modelID: "glm-4.7" },
          }),
        }),
      )
      // 确保 prompt 的模型不以 deepseek/ 开头
      const promptCall = (client.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(promptCall.body.model.providerID).not.toBe("deepseek")

      // 断言 7: 主模型 score 降低
      const afterScore = store.get("deepseek/v4-pro")
      expect(afterScore).toBe(initialScore - 20) // 100 - 20 = 80
      expect(afterScore).toBeLessThan(initialScore)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // C2: 自定义分类规则优先级
  // 用户规则优先于内置规则，纯 pattern 匹配不依赖状态码
  // ─────────────────────────────────────────────────────────────────────────
  describe("C2: 自定义分类规则优先级", () => {
    it("用户自定义规则优先匹配，不依赖 HTTP 状态码", async () => {
      // Step 1: 配置自定义分类规则（只有 pattern，无状态码）
      const config = makeConfig({
        classification: {
          rules: [{ statusCodes: [], patterns: ["%my custom error%"], category: "rate_limit" }],
        },
        agents: {
          build: { fallbackModels: ["deepseek/v4-pro"] },
          "*": { fallbackModels: [] },
        },
      })
      const store = new HealthStore(config)
      const selector = new ModelSelector(config, store)
      const dedupSet = new Set<string>()
      const pluginPromptedSessions = new Set<string>()
      const handledRetrySessions = new Set<string>()
      const messageCache = new Map<
        string,
        Array<{ modelKey: string; agentName: string; messageID: string }>
      >()
      const logger = createLogger({ level: "debug" })

      // cache: 当前使用 zhipuai/glm-5.1
      messageCache.set("ses-c2", [
        {
          modelKey: "zhipuai/glm-5.1",
          agentName: "build",
          messageID: "msg-c2-user",
        },
      ])

      const client = mockClient("success")
      client.session.messages = vi.fn().mockResolvedValue({
        data: [
          {
            info: {
              id: "msg-c2-user",
              role: "user",
              model: { providerID: "zhipuai", modelID: "glm-5.1" },
              agent: "build",
            },
            parts: [{ type: "text", text: "test" }],
          },
        ],
      })

      // Step 2: 错误消息 "my custom error occurred"（无 429 状态码）
      const errorMessage = "my custom error occurred"

      // 断言 4: 被分类为 rate_limit（用户规则匹配，不依赖 429 状态码）
      const classification = classify(errorMessage, config.classification.rules)
      expect(classification).not.toBeNull()
      expect(classification!.category).toBe("rate_limit")

      // Step 3: session.status retry (attempt=4)
      await handleReactiveEvent(
        {
          type: "session.status",
          properties: {
            sessionID: "ses-c2",
            status: { type: "retry", attempt: 4, message: errorMessage },
          },
        } as any,
        {
          client: client as any,
          store,
          selector,
          rules: config.classification.rules,
          maxRetries: 3,
          logger,
          dedupSet,
          pluginPromptedSessions,
          messageCache,
          handledRetrySessions,
        },
      )

      // 断言 5: 触发了 fallback 切换（abort + prompt 都被调用）
      expect(client.session.abort).toHaveBeenCalledWith({ path: { id: "ses-c2" } })
      expect(client.session.prompt).toHaveBeenCalled()
      // fallback 模型为 deepseek/v4-pro
      expect(client.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            model: { providerID: "deepseek", modelID: "v4-pro" },
          }),
        }),
      )
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // C3: 不可分类错误 — 静默跳过
  // 未知错误不触发 reactive，无副作用
  // ─────────────────────────────────────────────────────────────────────────
  describe("C3: 不可分类错误 — 静默跳过", () => {
    it("未知错误不触发 reactive 动作，无副作用", async () => {
      const config = makeConfig()
      const store = new HealthStore(config)
      const selector = new ModelSelector(config, store)
      const dedupSet = new Set<string>()
      const pluginPromptedSessions = new Set<string>()
      const handledRetrySessions = new Set<string>()
      const messageCache = new Map<
        string,
        Array<{ modelKey: string; agentName: string; messageID: string }>
      >()
      const logger = createLogger({ level: "debug" })

      // 预设一个模型分数，稍后验证不变
      store._set("zhipuai/glm-5.1", { score: 85, lastRecoveryAt: 0 })
      const scoreBefore = store.get("zhipuai/glm-5.1")

      // Step 1: 错误消息无法匹配任何规则
      const errorMessage = "Unknown cosmic ray interference bit flip detected"

      // 断言 3: 分类器返回 null
      const classification = classify(errorMessage, config.classification.rules)
      expect(classification).toBeNull()

      const client = mockClient("success")

      // Step 2: session.status retry (attempt=4)
      await handleReactiveEvent(
        {
          type: "session.status",
          properties: {
            sessionID: "ses-c3",
            status: { type: "retry", attempt: 4, message: errorMessage },
          },
        } as any,
        {
          client: client as any,
          store,
          selector,
          rules: config.classification.rules,
          maxRetries: 3,
          logger,
          dedupSet,
          pluginPromptedSessions,
          messageCache,
          handledRetrySessions,
        },
      )

      // 断言 4: 不执行 abort/revert/prompt
      expect(client.session.abort).not.toHaveBeenCalled()
      expect(client.session.revert).not.toHaveBeenCalled()
      expect(client.session.prompt).not.toHaveBeenCalled()

      // 断言 5: health score 不变
      expect(store.get("zhipuai/glm-5.1")).toBe(scoreBefore) // 85
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // C4: RetryCounter 集成 — 连续失败计数触发降级
  // 验证: 同一模型在时间窗口内连续失败 maxRetries 次后 shouldIntervene 触发
  // ─────────────────────────────────────────────────────────────────────────
  describe("C4: RetryCounter 连续失败计数", () => {
    it("连续失败 maxRetries 次后介入（serve 模式：每次 attempt=1）", async () => {
      // RetryCounter 单元行为验证
      const counter = new RetryCounter(60_000)
      expect(counter.increment("zhipuai/glm-5.1")).toBe(1)
      expect(counter.increment("zhipuai/glm-5.1")).toBe(2)
      expect(counter.increment("zhipuai/glm-5.1")).toBe(3)
      // 3 > 3 = false, no intervention yet
      expect(shouldIntervene(3, 3)).toBe(false)
      // 4 > 3 = true, triggers intervention!
      expect(shouldIntervene(counter.increment("zhipuai/glm-5.1"), 3)).toBe(true)

      // 集成测试：配置 maxRetries=3
      const config = makeConfig({ retryPolicy: { maxRetries: 3, retryWindowMs: 60_000 } })
      const store = new HealthStore(config)
      const selector = new ModelSelector(config, store)
      const dedupSet = new Set<string>()
      const pluginPromptedSessions = new Set<string>()
      const handledRetrySessions = new Set<string>()
      const messageCache = new Map<
        string,
        Array<{ modelKey: string; agentName: string; messageID: string }>
      >()
      const retryCounter = new RetryCounter(60_000)
      const logger = createLogger({ level: "debug" })

      // Helper: set up cache for each new session
      const setupCache = (sid: string) => {
        const messageID = `msg-${sid}-user`
        messageCache.set(sid, [{
          modelKey: "zhipuai/glm-5.1",
          agentName: "build",
          messageID,
        }])
      }

      const client = mockClient("success")

      // Step 1: 第一次 retry (session-A, attempt=1) → 计数=1, 不介入
      const sidA = "ses-c4-a"
      setupCache(sidA)
      client.session.messages = vi.fn().mockResolvedValue({
        data: [{
          info: { id: "msg-ses-c4-a-user", role: "user", model: { providerID: "zhipuai", modelID: "glm-5.1" }, agent: "build" },
          parts: [{ type: "text", text: "test" }],
        }],
      })
      await handleReactiveEvent(
        {
          type: "session.status",
          properties: { sessionID: sidA, status: { type: "retry", attempt: 1, message: "500 error" } },
        } as any,
        {
          client: client as any, store, selector, rules: config.classification.rules,
          maxRetries: 3, retryCounter, logger, dedupSet, pluginPromptedSessions, messageCache, handledRetrySessions,
        },
      )
      expect(client.session.abort).not.toHaveBeenCalled()
      expect(retryCounter.getCount("zhipuai/glm-5.1")).toBe(1)

      // Step 2: 第二次 retry (session-B, attempt=1) → 计数=2, 不介入
      const sidB = "ses-c4-b"
      setupCache(sidB)
      client.session.messages = vi.fn().mockResolvedValue({
        data: [{
          info: { id: "msg-ses-c4-b-user", role: "user", model: { providerID: "zhipuai", modelID: "glm-5.1" }, agent: "build" },
          parts: [{ type: "text", text: "test" }],
        }],
      })
      await handleReactiveEvent(
        {
          type: "session.status",
          properties: { sessionID: sidB, status: { type: "retry", attempt: 1, message: "500 error" } },
        } as any,
        {
          client: client as any, store, selector, rules: config.classification.rules,
          maxRetries: 3, retryCounter, logger, dedupSet, pluginPromptedSessions, messageCache, handledRetrySessions,
        },
      )
      expect(client.session.abort).not.toHaveBeenCalled()
      expect(retryCounter.getCount("zhipuai/glm-5.1")).toBe(2)

      // Step 3: 第三次 retry (session-C, attempt=1) → 计数=3, 3 > 3 = false, 不介入
      const sidC = "ses-c4-c"
      setupCache(sidC)
      client.session.messages = vi.fn().mockResolvedValue({
        data: [{
          info: { id: "msg-ses-c4-c-user", role: "user", model: { providerID: "zhipuai", modelID: "glm-5.1" }, agent: "build" },
          parts: [{ type: "text", text: "test" }],
        }],
      })
      await handleReactiveEvent(
        {
          type: "session.status",
          properties: { sessionID: sidC, status: { type: "retry", attempt: 1, message: "500 error" } },
        } as any,
        {
          client: client as any, store, selector, rules: config.classification.rules,
          maxRetries: 3, retryCounter, logger, dedupSet, pluginPromptedSessions, messageCache, handledRetrySessions,
        },
      )
      expect(client.session.abort).not.toHaveBeenCalled()
      expect(retryCounter.getCount("zhipuai/glm-5.1")).toBe(3)

      // Step 4: 第四次 retry (session-D, attempt=1) → 计数=4, 4 > 3 = true, 介入!
      const sidD = "ses-c4-d"
      setupCache(sidD)
      client.session.messages = vi.fn().mockResolvedValue({
        data: [{
          info: { id: "msg-ses-c4-d-user", role: "user", model: { providerID: "zhipuai", modelID: "glm-5.1" }, agent: "build" },
          parts: [{ type: "text", text: "test" }],
        }],
      })
      await handleReactiveEvent(
        {
          type: "session.status",
          properties: { sessionID: sidD, status: { type: "retry", attempt: 1, message: "500 error" } },
        } as any,
        {
          client: client as any, store, selector, rules: config.classification.rules,
          maxRetries: 3, retryCounter, logger, dedupSet, pluginPromptedSessions, messageCache, handledRetrySessions,
        },
      )
      // 4 > 3 = true → intervention triggered
      expect(client.session.abort).toHaveBeenCalled()
    })
  })
})
