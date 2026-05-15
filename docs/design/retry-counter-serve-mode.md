# Retry Counter: Serve Mode 降级修复设计

> 状态: DRAFT
> 日期: 2026-05-15
> 关联: `docs/superpowers/plans/2026-05-15-retry-counter-serve-mode.md`

---

## 1. 问题

### 1.1 现象

生产环境日志显示插件从未触发降级：

```
21 次 reactive.retry_event（全部 attempt=1）
19 次 reactive.retry_gate（1 <= maxRetries=2 → 不介入）
 2 次 reactive.classify_miss（"网络错误"不匹配分类规则）
 0 次 reactive.failure_recorded
 0 次 reactive.fallback_success
```

### 1.2 根因

OpenCode **serve 模式**在重试时创建**新 session**，每个新 session 的 `session.status retry` 事件始终携带 `attempt=1`。

```
用户消息 → session A → LLM → 429
  → serve 放弃 session A → 创建 session B → LLM → 429
  → 放弃 session B → 创建 session C → LLM → 429
  → 每次 emit retry_event: attempt=1, 新 sessionID
```

插件的 `shouldIntervene(attempt=1, maxRetries=2)` 永远返回 `false`（1 > 2 = false），
降级链路完全无法启动。

### 1.3 影响

- health score 永远 100（从未 recordFailure）
- preemptive 选择器永远选原模型（score 100 > 100 不变）
- 用户的 maxRetries 配置失效
- 模型 429 后持续 ~30 分钟反复失败，直到 rate limit 自然解除

---

## 2. 方案

### 2.1 核心思路

**不改 shouldIntervene 的逻辑**（`attempt > maxRetries`），**改数据源**：

在插件内部按模型（modelKey）计数 retry 事件。当同一模型在时间窗口内累计失败次数超过 maxRetries 时，触发降级。

```
retry_event(session=A, attempt=1, model=zhipuai/glm-5.1) → 计数 1/3 → 不介入
retry_event(session=B, attempt=1, model=zhipuai/glm-5.1) → 计数 2/3 → 不介入
retry_event(session=C, attempt=1, model=zhipuai/glm-5.1) → 计数 3/3 → 介入！
```

### 2.2 语义不变

- TUI 模式下：attempt 在同一 session 内递增（1→8），原有的 `attempt > maxRetries` 仍然生效
- Serve 模式下：每次 attempt=1，用插件内部计数器替代，语义等价

### 2.3 新增组件

#### RetryCounter 类

```typescript
class RetryCounter {
  private counts: Map<modelKey, { count: number; firstSeenAt: number }>
  private windowMs: number  // 时间窗口，默认 60_000

  increment(modelKey): number  // 返回当前计数
  reset(modelKey): void        // 清零
  getCount(modelKey): number   // 只读
  cleanup(): void              // 周期清理过期条目
}
```

---

## 3. 清理时机

| # | 时机 | 触发者 | 动作 | 目的 |
|---|------|--------|------|------|
| ① | 时间窗口过期 | `increment()` 内部自检 | `now - firstSeenAt > windowMs` → 重置 count=1 | 短暂 429 恢复后不累计 |
| ② | 模型恢复正常 | HealthStore `recordSuccess` 后 | `retryCounter.reset(modelKey)` | 成功说明模型好了，清零 |
| ③ | 降级切换成功 | reactive handler 成功切到 fallback 后 | `retryCounter.reset(原模型)` | 已切走，不再计数 |
| ④ | 周期清理 | tick timer（每 30 秒） | `retryCounter.cleanup()` | 清除过期条目，防内存泄漏 |

---

## 4. 代码改动点

### 4.1 新增文件

| 文件 | 职责 |
|------|------|
| `src/retry/counter.ts` | `RetryCounter` 类：按模型+时间窗口计数 |

### 4.2 修改文件

| 文件 | 改动 |
|------|------|
| `src/types.ts` | `RetryPolicyConfig` 新增 `retryWindowMs?: number` 字段 |
| `src/config/defaults.ts` | 新增 `DEFAULT_RETRY_WINDOW_MS = 60_000` |
| `src/config/schema.ts` | retryPolicySchema 新增 `retryWindowMs` 字段 |
| `src/config/generator.ts` | 模板中新增 `retryWindowMs` 配置项说明 |
| `src/actions/reactive.ts` | ① 在 classify 之后、shouldIntervene 之前 peek messageCache 拿 modelKey → increment → 用 count 替代 attempt ② 成功切换后 reset |
| `src/index.ts` | ① 创建 sharedRetryCounter ② tick timer 中调 cleanup() ③ 传给 ReactiveContext ④ recordSuccessOnComplete 中直接调用 retryCounter?.reset(key) |

### 4.3 不改的文件

| 文件 | 原因 |
|------|------|
| `src/retry/policy.ts` | shouldIntervene 逻辑不变（`attempt > maxRetries`），只是入参从 OpenCode 的 attempt 变成 RetryCounter 的 count |

---

## 5. 配置变更

### 5.1 新增配置项

```jsonc
{
  "retryPolicy": {
    "maxRetries": 3,
    "retryWindowMs": 60000  // 新增：计数器时间窗口（毫秒），默认 60 秒
  }
}
```

### 5.2 向后兼容

- `retryWindowMs` 可选，默认 60000
- 不配置时行为等同于新默认值
- `maxRetries` 保持原有含义

---

## 6. 测试覆盖

### 6.1 单元测试（新增）

| 文件 | 测试用例 |
|------|----------|
| `__tests__/unit/retry-counter.test.ts` | increment 返回递增计数 / 时间窗口过期后重置 / reset 清零 / cleanup 清理过期条目 / 不存在的 key 返回 0 |

### 6.2 修改的测试

| 文件 | 改动 |
|------|------|
| `__tests__/e2e/error-classification.test.ts` | C4 测试中传入 retryCounter，验证 3 次 increment 后 shouldIntervene 触发 |

### 6.3 不需要改的测试

| 文件 | 原因 |
|------|------|
| `__tests__/unit/retry-policy.test.ts` | shouldIntervene 逻辑不变 |
| `__tests__/e2e/plugin-lifecycle.test.ts` | 使用 attempt=4，maxRetries=3，已满足条件 |
| 其他集成/E2E 测试 | 使用足够高的 attempt 值 |

---

## 7. 风险评估

| 风险 | 等级 | 缓解 |
|------|------|------|
| 计数器内存泄漏 | 低 | cleanup() 在 tick timer 中定期执行，有过期机制 |
| peek messageCache 时 cache 为空 | 中 | 无 modelKey 时跳过计数，沿用原始 attempt（TUI 模式兼容） |
| 子会话 cache 为空时仅 abort，不 recordFailure | 低 | cache 为空时跳过 recordFailure 和 counter increment，abort 正常执行；后续 dispatch 仍用原模型 |
| 配置不支持运行时热加载 | 低 | 配置在首次 server() 调用时一次性加载，运行中修改配置文件不生效。这是插件架构的显式约束 |
| JavaScript 单线程无竞态 | 无 | cleanup(in tick timer) 和 increment(in event hook) 在同一主线程顺序执行，Map 操作不会被中断 |
| 短暂 429 被累计导致误切换 | 低 | 时间窗口机制确保间隔过长的失败不累计 |
| recordSuccess 清零导致计数丢失 | 无 | 成功说明模型已恢复，清零是正确行为 |
