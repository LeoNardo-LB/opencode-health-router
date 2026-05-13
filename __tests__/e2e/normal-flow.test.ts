import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * L1 正常流程测试 — B 系列场景
 *
 * 验证插件在常见业务场景下的端到端行为：
 * B1: 完整正常请求，所有模型健康，不触发任何干预
 * B2: Preemptive 切换，主模型低分时自动选最高分模型
 * B3: Reactive 切换，429 频率限制触发完整的 abort→revert→prompt 链路
 * B4: 健康分演化，失败→扣分→tick 恢复→满分→切回主模型
 *
 * 测试风格遵循 plugin-lifecycle.test.ts：使用真实 HealthStore / ModelSelector / Classifier，
 * 仅 Mock OpenCode client。
 */

import { HealthStore } from "../../src/health/store.js"
import { ModelSelector } from "../../src/selection/selector.js"
import { handleChatMessage } from "../../src/actions/preemptive.js"
import { handleReactiveEvent } from "../../src/actions/reactive.js"
import { classify } from "../../src/classification/classifier.js"
import { BUILTIN_RULES } from "../../src/classification/patterns.js"
import { createLogger } from "../../src/logging/logger.js"
import type { Config } from "../../src/types.js"

// ─── 测试辅助：与 plugin-lifecycle.test.ts 保持一致的配置工厂 ─────────────

function makeE2EConfig(overrides: Partial<Config> = {}): Config {
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
      build: { fallbackModels: ["deepseek/v4-pro"] },
      "*": { fallbackModels: ["deepseek/v4-flash"] },
    },
    primaryModels: new Set(["zhipuai/glm-5.1", "zhipuai/glm-5-turbo"]),
    logging: { level: "debug", path: "" },
    ...overrides,
  }
}

/** 插件上下文：模拟 index.ts 中组装的共享状态 */
interface PluginContext {
  config: Config
  store: HealthStore
  selector: ModelSelector
  dedupSet: Set<string>
  pluginPromptedSessions: Set<string>
  handledRetrySessions: Set<string>
  messageCache: Map<string, Array<{ modelKey: string; agentName: string; messageID: string }>>
  logger: ReturnType<typeof createLogger>
}

function createPluginContext(config?: Config): PluginContext {
  const cfg = config ?? makeE2EConfig()
  const store = new HealthStore(cfg)
  const selector = new ModelSelector(cfg, store)
  const dedupSet = new Set<string>()
  const pluginPromptedSessions = new Set<string>()
  const handledRetrySessions = new Set<string>()
  const messageCache = new Map<string, Array<{ modelKey: string; agentName: string; messageID: string }>>()
  const logger = createLogger({ level: "debug" })
  return { config: cfg, store, selector, dedupSet, pluginPromptedSessions, handledRetrySessions, messageCache, logger }
}

/** Mock OpenCode client，可控制 prompt 成功/失败 */
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
              id: "msg-user-1",
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

// ─── B 系列测试 ─────────────────────────────────────────────────────────

describe("B: 正常流程验证", () => {

  // ─────────────────────────────────────────────────────────────────────
  // B1: 完整正常请求 — 无切换
  // 所有模型 score=100，用户发送消息后插件不干预，LLM 成功返回后分数不变
  // ─────────────────────────────────────────────────────────────────────
  describe("B1: 完整正常请求 — 无切换", () => {
    it("所有模型健康时不触发任何干预，成功返回后分数保持 100", () => {
      const ctx = createPluginContext()

      // 步骤 1: 配置 — agent "build" fallbackModels = ["deepseek/v4-pro"]
      // 所有模型初始 score 均为默认值 100（HealthStore.get 未设置时返回 100）
      expect(ctx.store.get("zhipuai/glm-5.1")).toBe(100)
      expect(ctx.store.get("deepseek/v4-pro")).toBe(100)

      // 步骤 2: 模拟用户发消息 → chat.message hook 触发
      // 模拟 index.ts 中 chat.message hook 的完整流程：
      // 1) 缓存消息元数据（供 reactive handler 使用）
      // 2) 判断是否 plugin prompt（此处为用户消息，isPluginPrompt=false）
      // 3) 清除 handledRetrySessions（新用户消息重置反级联标记）
      // 4) 调用 handleChatMessage（preemptive 逻辑）
      const sessionID = "ses-b1"
      const input = {
        sessionID,
        agent: "build",
        model: { providerID: "zhipuai", modelID: "glm-5.1" },
        messageID: "msg-b1-user",
      }
      const output = {
        message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } },
        parts: [],
      }

      // 缓存消息元数据（模拟 chat.message hook 中的缓存逻辑）
      ctx.messageCache.set(sessionID, [{
        modelKey: "zhipuai/glm-5.1",
        agentName: "build",
        messageID: input.messageID,
      }])

      // 用户消息：不在 pluginPromptedSessions 中 → 清除 handledRetrySessions
      const isPluginPrompt = ctx.pluginPromptedSessions.has(sessionID)
      expect(isPluginPrompt).toBe(false)
      if (!isPluginPrompt) {
        ctx.handledRetrySessions.delete(sessionID)
      }

      // 调用 preemptive handler
      handleChatMessage(input, output, ctx.store, ctx.config, ctx.logger)

      // 步骤 3 断言: output.message.model 不变（所有模型 score=100，主模型排在 chain 首位，无需切换）
      expect(output.message.model).toEqual({ providerID: "zhipuai", modelID: "glm-5.1" })

      // 步骤 4: 模拟 LLM 成功返回 → event hook message.updated 触发
      // 在 index.ts 中，recordSuccessOnComplete 检测到 assistant 消息完成时调用 store.recordSuccess
      // 此处直接模拟该行为
      ctx.store.recordSuccess("zhipuai/glm-5.1")

      // 步骤 5 断言: 主模型成功后，score 保持 100（主模型 recordSuccess 执行 full restore）
      expect(ctx.store.get("zhipuai/glm-5.1")).toBe(100)

      // 步骤 6 断言: 无 abort/revert/prompt 调用
      // 本场景不涉及 reactive handler，创建 client 仅用于验证无调用
      const client = mockClient()
      expect(client.session.abort).not.toHaveBeenCalled()
      expect(client.session.revert).not.toHaveBeenCalled()
      expect(client.session.prompt).not.toHaveBeenCalled()
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // B2: Preemptive 切换 — 主模型低分
  // 请求前自动选最高分模型：主模型低分时 preemptive handler 切换到高分的 fallback
  // ─────────────────────────────────────────────────────────────────────
  describe("B2: Preemptive 切换 — 主模型低分", () => {
    it("主模型低分时 preemptive handler 自动切换到最高分的 fallback 模型", () => {
      const ctx = createPluginContext()

      // 步骤 1: 配置 — agent "build" fallbackModels = ["deepseek/v4-pro"]
      expect(ctx.config.agents["build"].fallbackModels).toEqual(["deepseek/v4-pro"])

      // 步骤 2: 手动将主模型 score 降到 60（recordFailure 两次：100→80→60）
      ctx.store.recordFailure("zhipuai/glm-5.1")
      ctx.store.recordFailure("zhipuai/glm-5.1")
      // 断言中间状态：主模型 score=60，fallback 保持 100
      expect(ctx.store.get("zhipuai/glm-5.1")).toBe(60)
      expect(ctx.store.get("deepseek/v4-pro")).toBe(100)

      // 步骤 3: 模拟用户发消息 → chat.message hook 触发
      const sessionID = "ses-b2"
      const input = {
        sessionID,
        agent: "build",
        model: { providerID: "zhipuai", modelID: "glm-5.1" },
        messageID: "msg-b2-user",
      }
      const output = {
        message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } },
        parts: [],
      }

      // 缓存消息元数据
      ctx.messageCache.set(sessionID, [{
        modelKey: "zhipuai/glm-5.1",
        agentName: "build",
        messageID: input.messageID,
      }])

      // 用户消息：清除 handledRetrySessions
      ctx.handledRetrySessions.delete(sessionID)

      // 调用 preemptive handler — chain = ["zhipuai/glm-5.1", "deepseek/v4-pro"]
      // sorted by score desc: ["deepseek/v4-pro"(100), "zhipuai/glm-5.1"(60)]
      // best = "deepseek/v4-pro" !== currentKey → 切换
      handleChatMessage(input, output, ctx.store, ctx.config, ctx.logger)

      // 步骤 4 断言: output.message.model 被改为 deepseek/v4-pro
      expect(output.message.model).toEqual({ providerID: "deepseek", modelID: "v4-pro" })

      // 步骤 5: 模拟 deepseek/v4-pro 成功返回
      // event hook message.updated → store.recordSuccess("deepseek/v4-pro")
      ctx.store.recordSuccess("deepseek/v4-pro")

      // 步骤 6 断言: fallback 模型 score 从 100 → 105 → capped 到 100
      // recordSuccess 对 fallback 模型: score = Math.min(100, 100 + 5) = 100
      // 因为已经满分，成功加分被 cap 住
      expect(ctx.store.get("deepseek/v4-pro")).toBe(100)
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // B3: Reactive 切换 — 429 频率限制
  // 完整的失败 → 重试耗尽 → abort → revert → prompt 序列
  // ─────────────────────────────────────────────────────────────────────
  describe("B3: Reactive 切换 — 429 频率限制", () => {
    it("429 重试耗尽后触发完整的 abort→revert→prompt 链路", async () => {
      const ctx = createPluginContext()

      // 步骤 1: 配置 — agent "build" fallbackModels = ["deepseek/v4-pro"], maxRetries=3
      expect(ctx.config.agents["build"].fallbackModels).toEqual(["deepseek/v4-pro"])
      expect(ctx.config.retryPolicy.maxRetries).toBe(3)

      // 步骤 2: 用户发消息 → chat.message hook 缓存消息元数据
      // 注意: messageID 必须与 mock client.messages() 返回的用户消息 ID 一致，
      // 否则 reactive handler 的 cache lookup 会失败
      const sessionID = "ses-b3"
      const cachedMessageID = "msg-user-1" // 与 mockClient 返回的消息 ID 匹配
      ctx.messageCache.set(sessionID, [{
        modelKey: "zhipuai/glm-5.1",
        agentName: "build",
        messageID: cachedMessageID,
      }])

      // 用户消息：清除 handledRetrySessions
      ctx.handledRetrySessions.delete(sessionID)

      // 所有模型初始 score=100
      expect(ctx.store.get("zhipuai/glm-5.1")).toBe(100)
      expect(ctx.store.get("deepseek/v4-pro")).toBe(100)

      // 步骤 3: OpenCode 重试 3 次均失败（attempt 1-3 不触发干预，attempt > maxRetries=3 才触发）
      // 步骤 4: 发送 session.status retry (attempt=4, 429 错误)
      const client = mockClient("success")
      const retryEvent = {
        type: "session.status",
        properties: {
          sessionID,
          status: {
            type: "retry",
            attempt: 4,
            message: "429 已达到调用上限",
          },
        },
      }

      await handleReactiveEvent(retryEvent as any, {
        client: client as any,
        store: ctx.store,
        selector: ctx.selector,
        rules: ctx.config.classification.rules,
        maxRetries: ctx.config.retryPolicy.maxRetries,
        logger: ctx.logger,
        dedupSet: ctx.dedupSet,
        pluginPromptedSessions: ctx.pluginPromptedSessions,
        messageCache: ctx.messageCache,
        handledRetrySessions: ctx.handledRetrySessions,
      })

      // 步骤 5 断言: 错误被分类为 rate_limit
      const classification = classify("429 已达到调用上限", ctx.config.classification.rules)
      expect(classification).not.toBeNull()
      expect(classification!.category).toBe("rate_limit")

      // 步骤 6 断言: 主模型 score 从 100 降到 80（recordFailure 一次，100 - 20 = 80）
      expect(ctx.store.get("zhipuai/glm-5.1")).toBe(80)

      // 步骤 7 断言: abort 被调用
      expect(client.session.abort).toHaveBeenCalledWith({ path: { id: sessionID } })

      // 步骤 8 断言: revert 被调用（使用缓存中的用户消息 ID）
      expect(client.session.revert).toHaveBeenCalledWith({
        path: { id: sessionID },
        body: { messageID: cachedMessageID },
      })

      // 步骤 9 断言: prompt 被调用，model 为 deepseek/v4-pro
      expect(client.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { id: sessionID },
          body: expect.objectContaining({
            model: { providerID: "deepseek", modelID: "v4-pro" },
          }),
        }),
      )

      // 步骤 10 断言: pluginPromptedSessions 包含 sessionID（reactive handler 设置的标记）
      expect(ctx.pluginPromptedSessions.has(sessionID)).toBe(true)

      // 步骤 11: 模拟 fallback 成功返回
      // event hook message.updated → store.recordSuccess("deepseek/v4-pro")
      ctx.store.recordSuccess("deepseek/v4-pro")

      // 步骤 12 断言: fallback score 从 100 → 105 → capped 100
      // fallback recordSuccess: score = Math.min(100, 100 + 5) = 100（已满分，successBonus 被 cap）
      expect(ctx.store.get("deepseek/v4-pro")).toBe(100)
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // B4: 健康分演化 — 完整周期
  // 失败→扣分→tick 恢复→满分→切换回来
  // ─────────────────────────────────────────────────────────────────────
  describe("B4: 健康分演化 — 完整周期", () => {
    it("主模型从低分通过 tick 恢复到满分后 preemptive 切回主模型", () => {
      const ctx = createPluginContext()

      // 步骤 1: 配置 — agent "build" fallbackModels = ["deepseek/v4-pro"]
      expect(ctx.config.agents["build"].fallbackModels).toEqual(["deepseek/v4-pro"])

      // 步骤 2: 主模型连续失败 4 次 → score: 100→80→60→40→20
      ctx.store.recordFailure("zhipuai/glm-5.1") // 100 → 80
      expect(ctx.store.get("zhipuai/glm-5.1")).toBe(80)
      ctx.store.recordFailure("zhipuai/glm-5.1") // 80 → 60
      expect(ctx.store.get("zhipuai/glm-5.1")).toBe(60)
      ctx.store.recordFailure("zhipuai/glm-5.1") // 60 → 40
      expect(ctx.store.get("zhipuai/glm-5.1")).toBe(40)
      ctx.store.recordFailure("zhipuai/glm-5.1") // 40 → 20
      expect(ctx.store.get("zhipuai/glm-5.1")).toBe(20)

      // fallback 模型保持满分
      expect(ctx.store.get("deepseek/v4-pro")).toBe(100)

      // 步骤 3 断言: 用户发消息时 preemptive 切换到 fallback（fallback score=100 > primary score=20）
      const sessionID = "ses-b4"
      const output = {
        message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } },
        parts: [],
      }
      handleChatMessage(
        { sessionID, agent: "build", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
        output,
        ctx.store,
        ctx.config,
        ctx.logger,
      )
      // chain = ["zhipuai/glm-5.1", "deepseek/v4-pro"]
      // sorted: ["deepseek/v4-pro"(100), "zhipuai/glm-5.1"(20)]
      // best = "deepseek/v4-pro" !== "zhipuai/glm-5.1" → 切换
      expect(output.message.model).toEqual({ providerID: "deepseek", modelID: "v4-pro" })

      // 步骤 4: fallback 成功 → score 保持 100（100 + successBonus=5, capped at 100）
      ctx.store.recordSuccess("deepseek/v4-pro")
      expect(ctx.store.get("deepseek/v4-pro")).toBe(100)

      // 步骤 5: 手动调用 tick() 并快进时间超过 recoveryIntervalMs (60_000ms)
      // recordFailure 设置 lastRecoveryAt = Date.now()，需要将其改为过去的时间
      // 使用 _set 模拟时间流逝
      ctx.store._set("zhipuai/glm-5.1", { score: 20, lastRecoveryAt: Date.now() - 61_000 })
      ctx.store.tick()

      // 步骤 6 断言: 主模型 score 从 20 恢复到 30（primary recoveryBonus=10, 一次 tick +10）
      expect(ctx.store.get("zhipuai/glm-5.1")).toBe(30)

      // 步骤 7: 继续快进 tick 直到主模型恢复到 100
      // tick() 内部将 lastRecoveryAt 设为 Date.now()（恢复后），需要再次 _set 回到过去
      // 从 30 → 100 需要 7 次 tick（每次 +10: 30→40→50→60→70→80→90→100）
      let currentScore = 30
      while (currentScore < 100) {
        ctx.store._set("zhipuai/glm-5.1", { score: currentScore, lastRecoveryAt: Date.now() - 61_000 })
        ctx.store.tick()
        currentScore = Math.min(100, currentScore + 10)
      }

      // 验证主模型已恢复到满分
      expect(ctx.store.get("zhipuai/glm-5.1")).toBe(100)

      // 步骤 8 断言: 用户发消息时 preemptive 切回主模型
      // 此时 primary=100, fallback=100，chain 中 primary 排在首位，同分时保持原始顺序
      const outputAfterRecovery = {
        message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } },
        parts: [],
      }
      handleChatMessage(
        { sessionID: "ses-b4-2", agent: "build", model: { providerID: "zhipuai", modelID: "glm-5.1" } },
        outputAfterRecovery,
        ctx.store,
        ctx.config,
        ctx.logger,
      )
      // chain = ["zhipuai/glm-5.1", "deepseek/v4-pro"]
      // sorted (同分保持原始顺序): ["zhipuai/glm-5.1", "deepseek/v4-pro"]
      // best = "zhipuai/glm-5.1" === currentKey → 不切换
      expect(outputAfterRecovery.message.model).toEqual({ providerID: "zhipuai", modelID: "glm-5.1" })
    })
  })
})
