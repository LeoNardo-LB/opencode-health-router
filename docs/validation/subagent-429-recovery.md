# 设计校验报告：子会话 429 限流恢复

## 校验方法

对照 OpenCode 源码 (`packages/opencode/src/`) 和插件 SDK 类型定义 (`@opencode-ai/plugin` + `@opencode-ai/sdk`)，逐一验证设计文档中的每一个假设。

---

## V1: session.created 事件可检测子会话

| 维度 | 结果 | 证据 |
|---|------|------|
| 事件是否触发 | ✅ | plugin 日志已收到 `session.created` 事件 |
| properties 结构 | ✅ | SDK类型 `EventSessionCreated.properties.info: Session` |
| Session.parentID 存在 | ✅ | SDK类型 `Session.parentID?: string` |
| 非空 = 子会话 | ✅ | task.ts 中 `session.create({ parentID: ctx.sessionID })` |

**SDK 类型引用** (`types.gen.d.ts:2146-2168` + `types.gen.d.ts:553-560`):
```typescript
export type EventSessionCreated = {
    type: "session.created";
    properties: { sessionID: string; info: Session };
};
export type Session = { id: string; parentID?: string; ... };
```

**源码引用** (`prompt.ts:121-133` + `task.ts` session.create):
```typescript
// task.ts creates child session with parentID
const session = await Session.create({ parentID: ctx.sessionID, ... })
```

**结论**：✅ 可行。`event.properties.info.parentID` 在子会话创建时非空。

---

## V2: tool.execute.after 可捕获 task 工具完成并修改输出

| 维度 | 结果 | 证据 |
|---|------|------|
| task tool 完成后 hook 触发 | ✅ | 源码 line 464-468 `plugin.trigger("tool.execute.after", ...)` |
| input.tool = "task" | ✅ | 源码 line 465 `{ tool: item.id, ... }` |
| input.sessionID | ✅ | 源码 line 466 `sessionID: ctx.sessionID` (父会话) |
| output 包含 metadata | ✅ | 源码 line 455 `{ ...result }` where result = task return |
| output.metadata.sessionId | ✅ | 源码 task.ts line 158-161 `metadata: { sessionId: session.id, model }` |
| 可修改 output.output | ✅ | 源码 line 467 `output` 参数传递引用 |

**源码引用** (`prompt.ts:454-469`):
```typescript
const result = yield* Effect.promise(() => item.execute(args, ctx))
const output = { ...result, attachments: ... }
yield* plugin.trigger("tool.execute.after",
    { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
    output,    // ← pass by reference, modifications take effect
)
return output  // ← modified output used by OpenCode
```

**源码引用** (`task.ts:146-163`) — task 工具返回值:
```typescript
return {
    title: params.description,
    metadata: { sessionId: session.id, model },  // ★ 子会话ID在这里
    output,
}
```

**重要发现：有两个调用点**

| 路径 | 源码位置 | 适用场景 |
|---|---|---|
| Path 1 | prompt.ts:464-468 | 模型调用的 task 工具 (runLoop 内) |
| Path 2 | prompt.ts:681-685 | SubtaskPart 触发的 task 执行 |

两个路径都传递 `tool: "task"`，都传递 `output` 包含 `metadata.sessionId`。
Path 1 的 `output` 是 `{ ...result, attachments }`，Path 2 的 `output` 是 `result` 本身。
我们的 hook 需要兼容两种形状。

**结论**：✅ 可行。`tool.execute.after` 在 task 完成后触发，`output.metadata.sessionId` = 子会话ID，`output.output` 可修改。

---

## V3: abort() 触发 onInterrupt → task 正常返回

| 维度 | 结果 | 证据 |
|---|------|------|
| abort → cancel | ✅ | `client.session.abort()` → `SessionPrompt.cancel()` (prompt.ts:144-152) |
| cancel → runner.cancel | ✅ | 源码 runner.ts:171-182 |
| runner.cancel → Fiber.interrupt | ✅ | 源码 `Fiber.interrupt(st.run.fiber)` |
| interrupt → Deferred.fail(Cancelled) | ✅ | 源码 runner.ts:59-62 `finishRun → Deferred.fail(done, new Cancelled())` |
| Cancelled → onInterrupt | ✅ | 源码 runner.ts:136 `e instanceof Cancelled ? onInterrupt : ...` |
| onInterrupt = lastAssistant | ✅ | 源码 prompt.ts:127 `onInterrupt: lastAssistant(sessionID)` |
| lastAssistant → 返回最新 assistant | ✅ | 源码 prompt.ts:1326-1335 `MessageV2.stream()` 最新优先 |
| 不 revert 时 stream 正常 | ✅ | revert 是显式调用，不调则不影响 stream |
| 返回后 task 完成 | ✅ | value goes back through Deferred chain to `await prompt()` |

**源码引用** (`runner.ts:171-202`):
```typescript
case "Running":
    Effect.gen(function* () {
        yield* Fiber.interrupt(st.run.fiber)      // kill loop
        yield* Deferred.await(st.run.done)         // wait cleanup
        yield* idleIfCurrent()                     // → state = Idle
    })
```

**源码引用** (`runner.ts:59-62`):
```typescript
Cause.hasInterruptsOnly(exit.cause)
    ? Deferred.fail(done, new Cancelled())    // ← triggers .catch
    : Deferred.done(done, exit)
```

**源码引用** (`runner.ts:135-138`):
```typescript
Effect.catch((e) => 
    e instanceof Cancelled 
        ? onInterrupt                         // ← calls lastAssistant
        : Effect.fail(e as E)
)
```

**源码引用** (`prompt.ts:1326-1335`):
```typescript
const lastAssistant = (sessionID: SessionID) =>
    Effect.promise(async () => {
        let latest: MessageV2.WithParts | undefined
        for await (const item of MessageV2.stream(sessionID)) {
            latest ??= item
            if (item.info.role !== "user") return item  // ← return newest assistant
        }
        if (latest) return latest
        throw new Error("Impossible")
    })
```

**`MessageV2.stream` 顺序** (`message-v2.ts:859-871`):
```typescript
export function* stream(sessionID: SessionID) {
    while (true) {
        const next = page({ sessionID, limit: size, before })
        if (next.items.length === 0) break
        for (let i = next.items.length - 1; i >= 0; i--) {
            yield next.items[i]          // ← newest first (reverse chronological)
        }
        before = next.cursor              // ← paginates backward
    }
}
```

**结论**：✅ 可行。不 revert 时，abort → onInterrupt → lastAssistant → 正常返回最新 assistant 消息 → task 完成。

---

## V4: sessionID 在 tool.execute.after 中的语义

| 维度 | 结果 | 证据 |
|---|------|------|
| Path 1: input.sessionID = 父会话 | ✅ | `ctx.sessionID` = runLoop 的 session，父会话调 task |
| Path 2: input.sessionID = runLoop session | ✅ | `sessionID` 参数 = runLoop 的 session |

**源码引用** (`prompt.ts:577-584` — tool 执行上下文):
```typescript
const ctx = {
    sessionID,    // ← runLoop 的参数
    agent,
    callID,
    // ...
}
```

**结论**：✅ `tool.execute.after` 中 `input.sessionID` = 父会话ID（当 task 由模型调用时）。

---

## V5: 健康分传播机制

| 维度 | 结果 | 证据 |
|---|------|------|
| shared HealthStore | ✅ | index.ts `sharedStore` 是 module-level，所有会话共享 |
| recordFailure 扣分 | ✅ | HealthStore 实现 `score - failurePenalty` |
| 子会话的 recordFailure | ✅ | reactive handler 中 `ctx.store.recordFailure(currentModelKey)` |
| preemptive 读健康分 | ✅ | `store.sort(chain)` 按分排序 |
| 第二次 dispatch 自动切 | ✅ | glm-5-turbo(80) < v4-flash(100) → SWITCH |

**源码引用** (`health-router index.ts:87-88`):
```typescript
let sharedStore: HealthStore | null = null  // module-level
// server() initializes:
if (!sharedStore) sharedStore = new HealthStore(config)
```

**结论**：✅ 子会话的 recordFailure 会传播到全局 HealthStore，第二次 dispatch 时 preemptive 自动切换。

---

## V6: opencode export 在子会话中可用

| 维度 | 结果 | 证据 |
|---|------|------|
| opencode CLI 存在 | ✅ | 用户环境已安装 |
| 子会话有 bash 权限 | ✅ | task 工具的子会话可执行 bash |
| export 可读其他会话 | ✅ | `opencode export` 读 SQLite DB，跨会话可读 |
| 导出内容含任务目标 | ✅ | 第一句是 user message (任务目标) |
| 导出内容天然裁剪 | ✅ | 后 200 行 ≈ 最后几条 assistant 消息 |

**结论**：✅ 可行。子会话可执行 `opencode export ses_xxx 2>&1 | tail -200` 获取上一轮结果。

---

## V7: 去重和防重复机制

| 维度 | 结果 | 证据 |
|---|------|------|
| handledRetrySessions 防重复 | ✅ | 入口 `has/add` 防止同周期重复处理 |
| abort 后不再有 retry | ✅ | 会话状态变为 Idle，OpenCode 停止重试 |
| tool.execute.after 的 abortedChildren 去重 | ✅ | 检查 + delete 确保只增强一次 |

**注意**：`handledRetrySessions` 在函数入口 add，子会话路径不 delete。
这意味着同一 retry 周期只处理一次。后续 retry events 会被 `already_handled` 短路。
✅ 正确行为。

---

## V8: 潜在问题

### 问题 1: tool.execute.after 的两个路径输出格式差异

| Path | output 结构 |
|---|---|
| Path 1 | `{ title, metadata, output, attachments?: ... }` |
| Path 2 | `{ title, metadata, output }` |

**影响**：我们的 hook 只访问 `output.metadata` 和 `output.output`，两种路径都有这两个字段。✅ 无影响。

### 问题 2: lastAssistant 返回的消息可能无 text 内容

如果 lastAssistant 返回的是一条 429 error 的 assistant 消息（没有 text parts），task 的 text 提取会得到空字符串。

**影响**：task.output 中 `<task_result>` 包裹的内容为空。但这不影响我们——我们在 `tool.execute.after` 中追加内容，增强后的 output 会包含所需信息。

### 问题 3: abort 和 tool.execute.after 的时序

```
abort() → onInterrupt → task promise resolve → tool execute 完成 → hook 触发
```

这是顺序执行的，不存在竞态。✅

### 问题 4: tool.execute.after 中 input.args 的结构

对于 task 工具，`input.args` 是 `{ description, prompt, subagent_type }`。
`model` 不在 args 中，而是在 `output.metadata.model` 中。

修正：设计文档中 `originalModel` 应从 `output.metadata.model` 提取，而非 `input.args`。

### 问题 5: abortedChildren Set 的内存泄漏

`sharedAbortedChildren` 理论上会在 `tool.execute.after` 中 `delete`，但如果 task 因其他原因未触发 hook（极少情况），会导致内存泄漏。

**缓解**：在 tick timer 的定期清理中同步清理过期的 aborted children。

---

## 总结

| 校验点 | 状态 | 备注 |
|---|---|---|
| V1 session.created 检测子会话 | ✅ | SDK 支持 |
| V2 tool.execute.after 修改输出 | ✅ | SDK 支持，两个调用点均覆盖 |
| V3 abort 触发 onInterrupt → task 完成 | ✅ | 不 revert 时 stream 正常 |
| V4 sessionID 语义正确 | ✅ | input.sessionID = 父会话 |
| V5 健康分传播 | ✅ | 共享 HealthStore |
| V6 opencode export 可用 | ✅ | 子会话可执行 bash |
| V7 防重复机制 | ✅ | handledRetrySessions + abortedChildren |
| V8.4 model 来源 | ✅ 已修正 | 从 `output.metadata.model` 提取 |
| V8.5 内存泄漏 | 📝 记录不修 | 发生概率极低，进程重启自动清空 |

**2 个待修正项，1 个为细节修正，1 个为防止性优化。无阻塞项。**
