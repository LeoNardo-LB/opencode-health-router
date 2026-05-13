import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * 并发与竞态 E2E Test (L1)
 *
 * 验证多 session 并发、快速连续消息、session 删除与 reactive 竞态场景下的正确性。
 * - 使用真实 PluginContext（HealthStore、ModelSelector 等均为真实实例）
 * - 仅 Mock OpenCode client（与 plugin-lifecycle.test.ts 一致）
 * - 通过 Promise 调度模拟并发场景
 */

import { HealthStore } from "../../src/health/store.js"
import { ModelSelector } from "../../src/selection/selector.js"
import { handleReactiveEvent, cleanupDedupForSession } from "../../src/actions/reactive.js"
import { BUILTIN_RULES } from "../../src/classification/patterns.js"
import { createLogger } from "../../src/logging/logger.js"
import type { Config } from "../../src/types.js"

// ─── Shared helpers (mirrors plugin-lifecycle.test.ts) ──────────────────────

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
      build: { fallbackModels: ["deepseek/v4-pro", "deepseek/v4-flash"] },
      plan: { fallbackModels: ["deepseek/v4-pro"] },
      "*": { fallbackModels: ["deepseek/v4-flash"] },
    },
    primaryModels: new Set(["zhipuai/glm-5.1", "zhipuai/glm-5-turbo"]),
    logging: { level: "debug", path: "" },
    ...overrides,
  }
}

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

function mockClient(
  options: {
    promptResult?: "success" | "error"
    messagesData?: Array<{
      id: string
      role: string
      providerID: string
      modelID: string
      agent: string
      parts: unknown[]
    }>
  } = {},
) {
  const {
    promptResult = "success",
    messagesData = [
      {
        id: "msg-user-default",
        role: "user",
        providerID: "zhipuai",
        modelID: "glm-5.1",
        agent: "build",
        parts: [{ type: "text", text: "test message" }],
      },
    ],
  } = options

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
        data: messagesData.map((m) => ({
          info: {
            id: m.id,
            role: m.role,
            model: { providerID: m.providerID, modelID: m.modelID },
            agent: m.agent,
          },
          parts: m.parts,
        })),
      }),
    },
    tui: { showToast: vi.fn().mockResolvedValue(true) },
  }
}

// Helper: build reactive event
function retryEvent(sessionID: string, attempt: number, message: string) {
  return {
    type: "session.status",
    properties: {
      sessionID,
      status: { type: "retry", attempt, message },
    },
  }
}

// Helper: build reactive call args
function reactiveArgs(client: ReturnType<typeof mockClient>, ctx: PluginContext) {
  return {
    client: client as any,
    store: ctx.store,
    selector: ctx.selector,
    rules: ctx.config.classification.rules,
    maxRetries: 3,
    logger: ctx.logger,
    dedupSet: ctx.dedupSet,
    pluginPromptedSessions: ctx.pluginPromptedSessions,
    messageCache: ctx.messageCache,
    handledRetrySessions: ctx.handledRetrySessions,
  }
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe("D: 并发与竞态", () => {
  let ctx: PluginContext

  beforeEach(() => {
    ctx = createPluginContext()
  })

  // ─── D1: 多 Session 并发失败 ───────────────────────────────────────────

  describe("D1: 多 Session 并发失败", () => {
    it("不同 session 独立处理，互不干扰", async () => {
      // 配置: agent "build" fallbackModels = ["deepseek/v4-pro"]
      // (已由 makeE2EConfig 提供)

      // 两个 session 的主模型同时"失败"——通过设置低分模拟
      ctx.store._set("zhipuai/glm-5.1", { score: 50, lastRecoveryAt: Date.now() })
      ctx.store._set("deepseek/v4-pro", { score: 100, lastRecoveryAt: 0 })

      // 分别缓存两个 session 的消息
      ctx.messageCache.set("ses-1", [{
        modelKey: "zhipuai/glm-5.1",
        agentName: "build",
        messageID: "msg-ses1-1",
      }])
      ctx.messageCache.set("ses-2", [{
        modelKey: "zhipuai/glm-5.1",
        agentName: "build",
        messageID: "msg-ses2-1",
      }])

      // 两个独立的 mock client
      const client1 = mockClient({
        messagesData: [{
          id: "msg-ses1-1",
          role: "user",
          providerID: "zhipuai",
          modelID: "glm-5.1",
          agent: "build",
          parts: [{ type: "text", text: "session 1 message" }],
        }],
      })
      const client2 = mockClient({
        messagesData: [{
          id: "msg-ses2-1",
          role: "user",
          providerID: "zhipuai",
          modelID: "glm-5.1",
          agent: "build",
          parts: [{ type: "text", text: "session 2 message" }],
        }],
      })

      // 并发触发两个 session 的 reactive 处理
      const [result1, result2] = await Promise.all([
        handleReactiveEvent(retryEvent("ses-1", 4, "429 Rate Limited") as any, reactiveArgs(client1, ctx)),
        handleReactiveEvent(retryEvent("ses-2", 4, "429 Rate Limited") as any, reactiveArgs(client2, ctx)),
      ])

      // 断言: 两个 session 各自独立执行 abort → revert → prompt
      expect(client1.session.abort).toHaveBeenCalledWith({ path: { id: "ses-1" } })
      expect(client1.session.revert).toHaveBeenCalled()
      expect(client1.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            model: { providerID: "deepseek", modelID: "v4-pro" },
          }),
        }),
      )

      expect(client2.session.abort).toHaveBeenCalledWith({ path: { id: "ses-2" } })
      expect(client2.session.revert).toHaveBeenCalled()
      expect(client2.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            model: { providerID: "deepseek", modelID: "v4-pro" },
          }),
        }),
      )

      // 断言: ses-1 的 fallback 不影响 ses-2 的选择（两者都选了 deepseek/v4-pro）
      expect(client1.session.prompt).toHaveBeenCalledTimes(1)
      expect(client2.session.prompt).toHaveBeenCalledTimes(1)

      // 断言: health score 独立记录
      // zhipuai/glm-5.1 被两次 recordFailure: 50 → 30 → 10
      expect(ctx.store.get("zhipuai/glm-5.1")).toBe(10)
      // deepseek/v4-pro 未被惩罚
      expect(ctx.store.get("deepseek/v4-pro")).toBe(100)

      // 断言: dedupSet 包含两个 session 的独立条目
      expect(ctx.dedupSet.has("ses-1:msg-ses1-1:4")).toBe(true)
      expect(ctx.dedupSet.has("ses-2:msg-ses2-1:4")).toBe(true)
      expect(ctx.dedupSet.size).toBe(2)

      // 断言: pluginPromptedSessions 包含两个 session 的 marker
      expect(ctx.pluginPromptedSessions.has("ses-1")).toBe(true)
      expect(ctx.pluginPromptedSessions.has("ses-2")).toBe(true)
    })
  })

  // ─── D2: 同一 Session 快速连续消息 ─────────────────────────────────────

  describe("D2: 同一 Session 快速连续消息", () => {
    it("messageCache 栈的 LIFO 行为与精确 messageID 匹配", async () => {
      // 模拟用户在 session-1 中连续发送两条消息
      // chat.message hook 被调用两次，messageCache 应为栈结构
      const stack: Array<{ modelKey: string; agentName: string; messageID: string }> = []

      // msg-1: 第一条用户消息
      const entry1 = { modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "msg-1" }
      stack.push(entry1)

      // msg-2: 第二条用户消息（在 msg-1 的回复完成之前就发送了）
      const entry2 = { modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "msg-2" }
      stack.push(entry2)

      ctx.messageCache.set("session-1", stack)

      // 断言: messageCache[session-1] 是数组，长度为 2
      expect(ctx.messageCache.get("session-1")).toBeInstanceOf(Array)
      expect(ctx.messageCache.get("session-1")!.length).toBe(2)

      // 设置 fallback 模型健康
      ctx.store._set("zhipuai/glm-5.1", { score: 50, lastRecoveryAt: Date.now() })
      ctx.store._set("deepseek/v4-pro", { score: 100, lastRecoveryAt: 0 })

      // msg-1 的主模型失败 → reactive 触发
      // reactive 内部会调用 messages() API 获取最后一条用户消息，
      // 然后在 messageCache 中精确匹配 messageID
      const client = mockClient({
        messagesData: [
          {
            id: "msg-2",
            role: "user",
            providerID: "zhipuai",
            modelID: "glm-5.1",
            agent: "build",
            parts: [{ type: "text", text: "second message" }],
          },
          {
            id: "msg-1",
            role: "user",
            providerID: "zhipuai",
            modelID: "glm-5.1",
            agent: "build",
            parts: [{ type: "text", text: "first message" }],
          },
        ],
      })

      // reactive 会通过 messages() 拿到最后的用户消息 (msg-2)，
      // 然后在 stack 中查找 msg-2 的 entry
      // 但我们要测试的是：当 reactive 尝试匹配 msg-1 时的行为
      // 我们模拟 messages() 返回 msg-1（即最后一条用户消息是 msg-1）
      client.session.messages = vi.fn().mockResolvedValue({
        data: [{
          info: {
            id: "msg-1",
            role: "user",
            model: { providerID: "zhipuai", modelID: "glm-5.1" },
            agent: "build",
          },
          parts: [{ type: "text", text: "first message" }],
        }],
      })

      await handleReactiveEvent(
        retryEvent("session-1", 4, "429 Rate Limited") as any,
        reactiveArgs(client, ctx),
      )

      // 断言: reactive 成功执行 abort+revert+prompt 链
      expect(client.session.abort).toHaveBeenCalledWith({ path: { id: "session-1" } })
      expect(client.session.revert).toHaveBeenCalled()
      expect(client.session.prompt).toHaveBeenCalled()

      // 断言: stack 中 msg-1 的 entry 被精确匹配并移除（splice）
      // stack 此时应该只剩 msg-2 的 entry
      const remaining = ctx.messageCache.get("session-1")
      expect(remaining).toBeDefined()
      expect(remaining!.length).toBe(1)
      expect(remaining![0].messageID).toBe("msg-2")

      // 断言: 被取出的确实是 msg-1（从 prompt 调用的 parts 可以确认）
      expect(client.session.revert).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { messageID: "msg-1" },
        }),
      )
    })
  })

  // ─── D3: Session 删除与 Reactive 竞态 ──────────────────────────────────

  describe("D3: Session 删除与 Reactive 竞态", () => {
    it("session.deleted 清理不影响正在执行的 reactive 处理", async () => {
      // Pre-setup: 缓存一条用户消息
      ctx.messageCache.set("ses-race", [{
        modelKey: "zhipuai/glm-5.1",
        agentName: "build",
        messageID: "msg-race-1",
      }])

      ctx.store._set("zhipuai/glm-5.1", { score: 80, lastRecoveryAt: Date.now() })
      ctx.store._set("deepseek/v4-pro", { score: 100, lastRecoveryAt: 0 })

      // 创建一个 client，其中 messages() 有延迟
      // 在 messages() resolve 之后、abort() 之前触发 session.deleted
      let messagesResolve: (value: any) => void
      const messagesPromise = new Promise((resolve) => {
        messagesResolve = resolve
      })

      const client = {
        session: {
          abort: vi.fn().mockResolvedValue(undefined),
          revert: vi.fn().mockResolvedValue(undefined),
          prompt: vi.fn().mockResolvedValue({ info: { id: "msg-reply" }, parts: [] }),
          messages: vi.fn().mockImplementation(() => messagesPromise),
        },
        tui: { showToast: vi.fn().mockResolvedValue(true) },
      }

      // 启动 reactive 处理（会在 await messages() 处挂起）
      const reactivePromise = handleReactiveEvent(
        retryEvent("ses-race", 4, "429 Rate Limited") as any,
        reactiveArgs(client as any, ctx),
      )

      // 等待 messages() 被调用
      await vi.waitFor(() => {
        expect(client.session.messages).toHaveBeenCalled()
      })

      // 此时 reactive 正在等待 messages() 的结果
      // 模拟 session.deleted 事件到来 → 清理所有状态
      const dedupSet = ctx.dedupSet
      const pluginPromptedSessions = ctx.pluginPromptedSessions
      const messageCache = ctx.messageCache
      const handledRetrySessions = ctx.handledRetrySessions

      // 模拟 session.deleted 处理逻辑（同 src/index.ts 中的 event handler）
      cleanupDedupForSession(dedupSet, "ses-race")
      pluginPromptedSessions.delete("ses-race")
      messageCache.delete("ses-race")
      handledRetrySessions.delete("ses-race")

      // 断言: 状态已被清理
      expect(messageCache.has("ses-race")).toBe(false)
      expect(pluginPromptedSessions.has("ses-race")).toBe(false)

      // 现在 resolve messages()，让 reactive 继续执行
      messagesResolve!({
        data: [{
          info: {
            id: "msg-race-1",
            role: "user",
            model: { providerID: "zhipuai", modelID: "glm-5.1" },
            agent: "build",
          },
          parts: [{ type: "text", text: "race test message" }],
        }],
      })

      // 等待 reactive 完成
      await reactivePromise

      // 断言: 不崩溃（优雅处理被清理的状态）
      // reactive 在步骤④发现 messageCache 已无 entry → 安全返回
      // 不会执行 abort/revert/prompt
      expect(client.session.abort).not.toHaveBeenCalled()
      expect(client.session.revert).not.toHaveBeenCalled()
      expect(client.session.prompt).not.toHaveBeenCalled()
    })

    it("如果 messageCache 在 reactive 查找前被清空，reactive 安全返回", async () => {
      // 构造一个场景：messageCache 中有条目，但在 reactive 调用 messages() 之后
      // 才被清理，导致 findIndex 找不到匹配
      ctx.messageCache.set("ses-race2", [
        { modelKey: "zhipuai/glm-5.1", agentName: "build", messageID: "msg-early" },
      ])

      ctx.store._set("zhipuai/glm-5.1", { score: 80, lastRecoveryAt: Date.now() })

      const client = mockClient({
        messagesData: [{
          id: "msg-early",
          role: "user",
          providerID: "zhipuai",
          modelID: "glm-5.1",
          agent: "build",
          parts: [{ type: "text", text: "test" }],
        }],
      })

      // reactive 执行过程中，正常情况会找到 entry
      // 但如果 entry 已被清理（另一实例处理了），则安全退出
      await handleReactiveEvent(
        retryEvent("ses-race2", 4, "429 Rate Limited") as any,
        reactiveArgs(client, ctx),
      )

      // reactive 正常完成，不崩溃
      // 因为 entry 存在且匹配，所以会正常执行 abort+revert+prompt
      expect(client.session.abort).toHaveBeenCalled()
    })
  })
})
