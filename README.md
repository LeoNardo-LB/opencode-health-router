# opencode-health-router

OpenCode 插件：基于健康评分的 LLM 模型自动降级与恢复。

当主模型遇到 429 Rate Limit、5xx 服务错误、超时等情况时，自动切换到 fallback 模型。子会话（subagent）遇到 429 时采用 abort-only 策略，避免父会话 hang 死。

## 工作原理

```
用户消息 → [preemptive] 按健康分选最优模型 → LLM 请求
                                                    ↓ 失败
                                            [reactive] abort → revert → prompt(fallback)
                                                    ↓ 子会话失败
                                            abort-only → tool.execute.after 增强输出
```

**双层机制**：
- **Preemptive（主动）**：每条消息发送前，按健康分排序选择最优模型
- **Reactive（被动）**：LLM 请求失败后（重试超限），执行 abort+revert+prompt 切换到 fallback

**错误分类**：429 rate_limit · 500/502/503/504 5xx · 529 overloaded · quota_exceeded（排除同厂商所有模型）· timeout · network

## 安装

1. 在全局 opencode 配置 `~/.config/opencode/opencode.jsonc` 中注册插件：

```jsonc
{
  "plugin": ["file:///path/to/opencode-health-router/dist/index.bundle.js"]
}
```

2. 在项目目录 `.opencode/health-router.json` 中配置 fallback 链：

```json
{
  "enabled": true,
  "agents": {
    "build": {
      "fallbackModels": ["deepseek/v4-pro", "deepseek/v4-flash"]
    }
  },
  "logging": {
    "level": "info",
    "path": "/tmp/health-router.log"
  }
}
```

首次运行时，插件会自动在 `.opencode/` 下生成配置模板。

## 配置参考

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 启用/禁用插件 |
| `healthScore.failurePenalty` | `20` | 每次失败扣分（满分 100） |
| `healthScore.primary.recoveryIntervalMs` | `60000` | 主模型恢复间隔（ms） |
| `healthScore.primary.recoveryBonus` | `10` | 主模型每次恢复加分 |
| `healthScore.fallback.successBonus` | `5` | fallback 模型成功加分 |
| `retryPolicy.maxRetries` | `3` | OpenCode 内置重试次数超过此值后插件接管 |
| `agents.<name>.fallbackModels` | `[]` | fallback 模型链（按优先级排序） |
| `classification.rules` | 内置规则 | 自定义错误分类规则（优先于内置规则） |

## 子会话 429 恢复

当 subagent（task 工具派发的子会话）遇到 429 时：

1. 插件只执行 `abort()`（不 revert/prompt），利用 OpenCode 原生 `onInterrupt` 让 task 正常返回
2. `tool.execute.after` hook 增强输出，附加失败会话 ID 和恢复说明
3. 父会话 AI 看到增强输出后可重新 dispatch，新子会话用 `opencode export` 读取上一轮进展
4. preemptive handler 检测到降分后自动切换模型

详细设计见 [docs/design/subagent-429-recovery.md](docs/design/subagent-429-recovery.md)。

## 开发

```bash
npm run build    # 构建
npm test         # 运行测试（148 个单元/集成测试）
npm run test:e2e # 运行 E2E 测试（需 E2E_SERVE_ENABLED=1）
```

## 项目结构

```
src/
  index.ts              # 插件入口
  actions/reactive.ts   # 被动响应处理器
  actions/preemptive.ts # 主动切换处理器
  classification/       # 错误分类（内置规则 + 自定义规则）
  config/               # 配置加载与校验
  health/store.ts       # 健康分存储
  selection/selector.ts # 模型选择器
  retry/policy.ts       # 重试策略
  logging/logger.ts     # 结构化日志
```
