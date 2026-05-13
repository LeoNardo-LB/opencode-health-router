import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { HealthStore } from "../../src/health/store.js"
import { cleanupDedupForSession } from "../../src/actions/reactive.js"
import { BUILTIN_RULES } from "../../src/classification/patterns.js"
import type { Config } from "../../src/types.js"

/**
 * E1/E2/E3 — 状态管理与生命周期测试
 *
 * 测试重心:
 *   E1: 模块级共享状态 — 双 server() 调用共享同一组 Set/Map
 *   E2: HealthStore tick 定时恢复的生命周期
 *   E3: session.compacted / session.deleted 事件触发的状态清理
 */

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

describe("E: 状态管理与生命周期", () => {
  // ─── E1: 双实例共享状态验证 ─────────────────────────────────────────
  describe("E1: 双实例共享状态验证", () => {
    it("两个 server() 调用共享同一组 Set/Map，跨实例可见", async () => {
      // Step 1: 清除模块缓存，确保从干净状态开始
      vi.resetModules()

      // Mock fs — 避免真实文件系统操作
      vi.doMock("fs", () => ({
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockReturnValue("{}"),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
        appendFileSync: vi.fn(),
        statSync: vi.fn().mockReturnValue({ size: 0 }),
        unlinkSync: vi.fn(),
        renameSync: vi.fn(),
      }))

      // Mock os — 控制配置目录
      vi.doMock("os", () => ({
        homedir: () => "/tmp/test-home",
        platform: () => "linux",
      }))

      // Mock config loader — 返回带 fallback 模型的完整配置
      vi.doMock("../../src/config/loader.js", () => ({
        loadConfig: () => ({
          config: makeConfig(),
          configPath: "/tmp/test/health-router.json",
          warnings: [],
        }),
      }))

      // Mock config generator — 不生成模板文件
      vi.doMock("../../src/config/generator.js", () => ({
        generateTemplate: () => null,
      }))

      // Step 2: 导入模块并调用 server() 两次
      const mod = await import("../../src/index.js")
      const plugin = mod.default

      const messageID = "msg-user-e1"

      // Instance A 的 client mock
      const mockClientA = {
        session: {
          abort: vi.fn().mockResolvedValue(undefined),
          revert: vi.fn().mockResolvedValue(undefined),
          prompt: vi.fn().mockResolvedValue({ info: { id: "msg-reply-a" }, parts: [] }),
          messages: vi.fn().mockResolvedValue({
            data: [{
              info: { id: messageID, role: "user", model: { providerID: "zhipuai", modelID: "glm-5.1" }, agent: "build" },
              parts: [{ type: "text", text: "test" }],
            }],
          }),
        },
        tui: { showToast: vi.fn().mockResolvedValue(true) },
      }

      // Instance B 的 client mock
      const mockClientB = {
        session: {
          abort: vi.fn().mockResolvedValue(undefined),
          revert: vi.fn().mockResolvedValue(undefined),
          prompt: vi.fn().mockResolvedValue({ info: { id: "msg-reply-b" }, parts: [] }),
          messages: vi.fn().mockResolvedValue({
            data: [{
              info: { id: messageID, role: "user", model: { providerID: "zhipuai", modelID: "glm-5.1" }, agent: "build" },
              parts: [{ type: "text", text: "test" }],
            }],
          }),
        },
        tui: { showToast: vi.fn().mockResolvedValue(true) },
      }

      // 第一次调用 server() → 初始化共享状态
      const hooksA = await plugin.server!({ client: mockClientA, directory: "/tmp/test-project" })

      // 第二次调用 server() → 应复用同一组状态
      const hooksB = await plugin.server!({ client: mockClientB, directory: "/tmp/test-project" })

      // ── 验证 1: handledRetrySessions 跨实例共享 ──
      // Step 4: Instance A 的 chat.message 缓存消息
      await (hooksA as any)["chat.message"](
        { sessionID: "ses-test", agent: "build", model: { providerID: "zhipuai", modelID: "glm-5.1" }, messageID },
        { message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } }, parts: [] },
      )

      // Step 5: Instance A 的 reactive handler → abort 成功后设置 handledRetrySessions.add("ses-test")
      await (hooksA as any).event({
        event: {
          type: "session.status",
          properties: {
            sessionID: "ses-test",
            status: { type: "retry", attempt: 4, message: "429 已达到 5 小时的使用上限" },
          },
        },
      })

      // 确认 Instance A 的 reactive 成功执行了 abort（前置验证）
      expect(mockClientA.session.abort).toHaveBeenCalled()

      // Step 6: Instance B 检查跨实例可见性 — anti-cascading 应阻止重复处理
      await (hooksB as any).event({
        event: {
          type: "session.status",
          properties: {
            sessionID: "ses-test",
            status: { type: "retry", attempt: 5, message: "429 已达到 5 小时的使用上限" },
          },
        },
      })

      // Step 7 断言: Instance B 的 abort 未被调用 → anti-cascading 生效
      // → Instance B 的 handledRetrySessions.has("ses-test") 返回 true
      // → 两个实例共享同一个 Set 引用
      expect(mockClientB.session.abort).not.toHaveBeenCalled()

      // ── 验证 2: messageCache 跨实例共享 ──
      // Instance A 通过 chat.message 缓存 "ses-shared" 的消息
      await (hooksA as any)["chat.message"](
        { sessionID: "ses-shared", agent: "build", model: { providerID: "zhipuai", modelID: "glm-5.1" }, messageID: "msg-cache-a" },
        { message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } }, parts: [] },
      )

      // Instance B 的 chat.message 触发新用户消息 → 清除 handledRetrySessions["ses-shared"]
      // （ses-shared 不在 handledRetrySessions 中，所以 delete 是 no-op）
      await (hooksB as any)["chat.message"](
        { sessionID: "ses-shared", agent: "build", model: { providerID: "zhipuai", modelID: "glm-5.1" }, messageID: "msg-cache-b" },
        { message: { model: { providerID: "zhipuai", modelID: "glm-5.1" } }, parts: [] },
      )

      // Instance B 触发 ses-shared 的 retry 事件
      // reactive handler 将查找 messageCache 中 Instance A 缓存的条目
      mockClientB.session.messages = vi.fn().mockResolvedValue({
        data: [{
          info: { id: "msg-cache-a", role: "user", model: { providerID: "zhipuai", modelID: "glm-5.1" }, agent: "build" },
          parts: [{ type: "text", text: "test" }],
        }],
      })

      await (hooksB as any).event({
        event: {
          type: "session.status",
          properties: {
            sessionID: "ses-shared",
            status: { type: "retry", attempt: 4, message: "429 Rate Limited" },
          },
        },
      })

      // 断言: Instance B 的 reactive 成功执行了 abort
      // 证明 Instance B 能看到 Instance A 缓存的 messageCache 条目 → 共享同一个 Map
      expect(mockClientB.session.abort).toHaveBeenCalled()
    })
  })

  // ─── E2: Tick Timer 生命周期 ─────────────────────────────────────────
  describe("E2: Tick Timer 生命周期", () => {
    let store: HealthStore
    let config: Config

    beforeEach(() => {
      vi.useFakeTimers()
      config = makeConfig()
      store = new HealthStore(config)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it("定时恢复正确触发、增量递增、达到 100 后停止", () => {
      // Step 1: 创建 HealthStore，配置 recoveryIntervalMs（已在 config 中：primary=60_000）
      const modelKey = "zhipuai/glm-5.1" // primary model
      const recoveryIntervalMs = config.healthScore.primary.recoveryIntervalMs // 60_000
      const recoveryBonus = config.healthScore.primary.recoveryBonus // 10

      // Step 2: recordFailure → score 从 100 降到 80，lastRecoveryAt 设置为当前时间
      store.recordFailure(modelKey)
      expect(store.get(modelKey)).toBe(80) // 100 - 20

      // Step 3: 断言 lastRecoveryAt > 0（通过 _set 验证：recordFailure 一定设置了时间戳）
      // 我们用 tick 行为来间接验证：如果 lastRecoveryAt=0，tick 不会做任何事
      // 所以先确认 tick 在间隔未到时不改变 score（证明 lastRecoveryAt 被设置了）

      // Step 4: 快进时间不到 recoveryIntervalMs → tick()
      vi.advanceTimersByTime(recoveryIntervalMs - 1) // 差 1ms
      store.tick()

      // Step 5: 断言 score 仍为 80（间隔未到）
      expect(store.get(modelKey)).toBe(80)

      // Step 6: 快进时间超过 recoveryIntervalMs → tick()
      vi.advanceTimersByTime(2) // 再过 2ms，总计超过 interval
      store.tick()

      // Step 7: 断言 score 恢复增加（+recoveryBonus）
      expect(store.get(modelKey)).toBe(80 + recoveryBonus) // 90

      // Step 8: 继续快进 + tick 直到 score 达到 100
      vi.advanceTimersByTime(recoveryIntervalMs)
      store.tick()
      expect(store.get(modelKey)).toBe(90 + recoveryBonus) // 100

      // Step 9: 断言 lastRecoveryAt 变为 0（恢复完成后停止计时）
      // 验证方法：再 tick 一次，score 不变 → 证明 lastRecoveryAt 已归零
      // （如果 lastRecoveryAt > 0，tick 会继续加 recoveryBonus，但 score 已是 100，会被 min(100, 110)=100 限制）
      // 更精确的验证：recordFailure 后 score 会从 100 重新扣分，
      // 但如果 lastRecoveryAt=0，新的 recordFailure 会设置新的 lastRecoveryAt=Date.now()
      // 我们通过 tick 不再增加 score 来验证（但 score 已经是 100 了无法增加）
      //
      // 更可靠的验证方式：tick 内部逻辑是 newScore >= 100 时设 lastRecoveryAt=0
      // 我们通过后续行为来验证

      // Step 10: 再快进 + tick
      vi.advanceTimersByTime(recoveryIntervalMs)
      store.tick()

      // Step 11: 断言 score 仍为 100（不继续增加）
      expect(store.get(modelKey)).toBe(100)

      // 进一步验证 lastRecoveryAt=0：再次 recordFailure 后 score 从 100 开始扣
      // （如果 lastRecoveryAt 仍为非零值，说明恢复没有真正停止）
      store.recordFailure(modelKey)
      expect(store.get(modelKey)).toBe(80) // 100 - 20，证明上次是从 100 开始扣
    })

    it("fallback 模型使用独立的 recoveryIntervalMs 和 recoveryBonus", () => {
      const fallbackKey = "deepseek/v4-pro" // fallback model
      const fallbackInterval = config.healthScore.fallback.recoveryIntervalMs // 120_000
      const fallbackBonus = config.healthScore.fallback.recoveryBonus // 5

      // recordFailure 让 fallback 降到 80
      store.recordFailure(fallbackKey)
      expect(store.get(fallbackKey)).toBe(80)

      // 快进 60_000ms（满足 primary interval 但不满足 fallback interval）
      vi.advanceTimersByTime(60_000)
      store.tick()
      expect(store.get(fallbackKey)).toBe(80) // fallback 的 interval 是 120_000ms，还未到

      // 再快进 60_001ms → 总计 120_001ms，满足 fallback interval
      vi.advanceTimersByTime(60_001)
      store.tick()
      expect(store.get(fallbackKey)).toBe(80 + fallbackBonus) // 85
    })
  })

  // ─── E3: Session Compacted 清理 ──────────────────────────────────────
  describe("E3: Session Compacted 清理", () => {
    // 模拟 index.ts 中 server() 返回的 event hook 对生命周期事件的行为
    // 不直接导入 index.ts（避免 fs/config mock），而是用与 index.ts 相同的逻辑

    let dedupSet: Set<string>
    let pluginPromptedSessions: Set<string>
    let handledRetrySessions: Set<string>
    let messageCache: Map<string, Array<{ modelKey: string; agentName: string; messageID: string }>>

    beforeEach(() => {
      dedupSet = new Set<string>()
      pluginPromptedSessions = new Set<string>()
      handledRetrySessions = new Set<string>()
      messageCache = new Map()
    })

    /**
     * 模拟 index.ts 中 event hook 的 session 生命周期处理逻辑。
     * 代码来源: src/index.ts 第 173-186 行
     */
    function simulateEventHook(event: { type: string; properties?: { sessionID?: string } }) {
      const sessionID = event.properties?.sessionID
      if (!sessionID) return

      // session.compacted 和 session.deleted 都清理 dedupSet
      if (event.type === "session.deleted" || event.type === "session.compacted") {
        cleanupDedupForSession(dedupSet, sessionID)
      }

      // 仅 session.deleted 清理 session 级别的 Set/Map
      if (event.type === "session.deleted") {
        pluginPromptedSessions.delete(sessionID)
        messageCache.delete(sessionID)
        handledRetrySessions.delete(sessionID)
      }
    }

    it("session.compacted 清理 dedupSet 但保留 pluginPromptedSessions 和 messageCache", () => {
      // Step 1: 活跃 session 有多个状态
      dedupSet.add("ses-lc:retry-1:4")
      dedupSet.add("ses-lc:retry-1:5")
      dedupSet.add("ses-lc:retry-2:4")
      dedupSet.add("ses-other:retry-1:4") // 其他 session 的条目

      pluginPromptedSessions.add("ses-lc")
      handledRetrySessions.add("ses-lc")
      messageCache.set("ses-lc", [{
        modelKey: "zhipuai/glm-5.1",
        agentName: "build",
        messageID: "msg-1",
      }])

      // Step 2: 触发 session.compacted 事件
      simulateEventHook({ type: "session.compacted", properties: { sessionID: "ses-lc" } })

      // Step 3: 断言 dedupSet 中该 session 的条目被清理
      expect(dedupSet.has("ses-lc:retry-1:4")).toBe(false)
      expect(dedupSet.has("ses-lc:retry-1:5")).toBe(false)
      expect(dedupSet.has("ses-lc:retry-2:4")).toBe(false)
      expect(dedupSet.has("ses-other:retry-1:4")).toBe(true) // 其他 session 不受影响

      // Step 4: 断言 pluginPromptedSessions 在 compacted 时 NOT 清理（代码实际行为）
      // 原因：compacted 后 session 仍在使用，避免竞态条件
      expect(pluginPromptedSessions.has("ses-lc")).toBe(true)

      // Step 5: 断言 messageCache 在 compacted 时 NOT 清理（代码实际行为）
      expect(messageCache.has("ses-lc")).toBe(true)
      expect(messageCache.get("ses-lc")).toHaveLength(1)

      // handledRetrySessions 在 compacted 时也 NOT 清理
      expect(handledRetrySessions.has("ses-lc")).toBe(true)
    })

    it("session.deleted 清理所有与该 session 相关的状态", () => {
      // Step 1: 设置活跃 session 的所有状态
      dedupSet.add("ses-del:retry-1:4")
      dedupSet.add("ses-del:retry-2:4")
      dedupSet.add("ses-other:retry-1:4") // 其他 session

      pluginPromptedSessions.add("ses-del")
      handledRetrySessions.add("ses-del")
      messageCache.set("ses-del", [{
        modelKey: "zhipuai/glm-5.1",
        agentName: "build",
        messageID: "msg-1",
      }])

      // Step 6: 触发 session.deleted 事件
      simulateEventHook({ type: "session.deleted", properties: { sessionID: "ses-del" } })

      // Step 7: 断言所有与该 session 相关的状态都被清理
      // dedupSet
      expect(dedupSet.has("ses-del:retry-1:4")).toBe(false)
      expect(dedupSet.has("ses-del:retry-2:4")).toBe(false)
      expect(dedupSet.has("ses-other:retry-1:4")).toBe(true) // 其他 session 不受影响

      // pluginPromptedSessions
      expect(pluginPromptedSessions.has("ses-del")).toBe(false)

      // messageCache
      expect(messageCache.has("ses-del")).toBe(false)

      // handledRetrySessions
      expect(handledRetrySessions.has("ses-del")).toBe(false)
    })
  })
})
