# opencode-health-router

OpenCode 插件：基于健康评分的 LLM 模型自动降级与恢复。当主模型 429/5xx/超时时，自动切换到 fallback 模型。

## 项目结构

```
src/
  index.ts              # 插件入口：hook 注册、共享状态、tick timer
  actions/
    reactive.ts         # 被动响应：session.status retry → abort+revert+prompt（主会话）/ abort-only（子会话）
    preemptive.ts       # 主动切换：chat.message → 按健康分选最优模型
  classification/
    classifier.ts       # 错误消息分类（429/5xx/timeout/quota_exceeded/overloaded）
    patterns.ts         # 内置规则（SQL 风格 % 通配符）
  config/
    loader.ts           # 加载配置（JSONC、merge、校验）
    schema.ts           # Zod schema + 默认值
    generator.ts        # 首次运行自动生成模板
    defaults.ts         # 默认配置常量
  health/store.ts       # 健康分存储（扣分/恢复/sort）
  selection/selector.ts # 模型选择器（fallback 链 + excludeProvider）
  retry/policy.ts       # 重试门控（attempt > maxRetries）
  logging/logger.ts     # 结构化日志（appendFileSync + 轮转）
  types.ts              # 类型定义 + splitModelKey
  jsonc.ts              # JSONC 解析器
```

## 命令速查

| 命令 | 用途 |
|------|------|
| `npm run build` | tsc + esbuild 打包到 `dist/index.bundle.js` |
| `npm test` | vitest run（148 测试，不含 E2E） |
| `E2E_SERVE_ENABLED=1 npm run test:e2e` | 进程级 E2E（需 opencode serve 可用） |

## 硬边界规则

- **禁止修改 OpenCode 源码**：此项目是纯插件，只能用 `@opencode-ai/plugin` SDK
- **共享状态必须在 module-level**：OpenCode 调用 `server()` 两次，模块级变量确保双实例共享
- **子会话（parentID 非空）只 abort，不 revert/prompt**：revert 删消息导致 `onInterrupt` 的 `lastAssistant` stream 断裂，prompt 会因 Runner busy 失败
- **hook 中 `handledRetrySessions.add()` 必须在第一个 await 之前**：防止并发 retry 事件的竞态条件
- **E2E 测试禁止覆盖 `XDG_CACHE_HOME`**：`@ai-sdk/openai-compatible` 在 `~/.cache/opencode/` 下，覆盖会导致 provider 加载挂死

## 配置文件位置

| 文件 | 路径 | 用途 |
|------|------|------|
| 全局 opencode 配置 | `~/.config/opencode/opencode.jsonc` | provider 定义 + plugin 注册 |
| 项目级 opencode 配置 | `<project>/.opencode/opencode.jsonc` | agent 模型、provider 覆盖 |
| 项目级插件配置 | `<project>/.opencode/health-router.json` | 健康分参数、fallback 链、分类规则 |
| 插件日志 | 由配置 `logging.path` 指定 | 结构化 JSON 日志 |

## E2E 测试要点

- E2E 测试用 `describe.skipIf(!E2E_SERVE_ENABLED)` 做安全门控
- Mock LLM Server 在 `__tests__/e2e/mock-llm-server.ts`，支持队列式响应编程
- opencode serve API：`POST /session?directory=...`（创建）、`POST /session/:id/prompt_async`（非阻塞发消息）
- 端口分配：原有 E2E 用 19701-19703，综合 E2E 用 19705-19707
- `prompt_async` 返回 204 立即，测试需 setTimeout 等待 LLM 响应

## 深入文档

| 主题 | 位置 |
|------|------|
| 子会话 429 恢复设计 | `docs/design/subagent-429-recovery.md` |
| 实施计划 | `docs/plan/subagent-429-recovery.md` |
| 设计校验报告 | `docs/validation/subagent-429-recovery.md` |
