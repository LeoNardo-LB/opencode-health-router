# 实施计划：子会话 429 限流恢复

## 变更清单

| # | 文件 | 位置 | 变更 | 行数 |
|---|---|------|------|------|------|
| P1 | src/index.ts | module-level state | 新增 `sharedChildSessions`, `sharedAbortedChildren` | +4 |
| P2 | src/index.ts | server() 初始化 | 懒初始化两个 Set | +2 |
| P3 | src/index.ts | event hook | 新增 `session.created` 处理 | +8 |
| P4 | src/actions/reactive.ts | handleReactiveEvent | 子会话走 abort-only 路径 | +10 |
| P5 | src/index.ts | server() 返回 | 新增 `tool.execute.after` hook | +25 |

## 详细实现

### P1: 新增共享状态

```typescript
// src/index.ts module-level
let sharedChildSessions: Set<string> | null = null
let sharedAbortedChildren: Set<string> | null = null
```

### P2: 懒初始化

```typescript
// src/index.ts server() 函数内，其他 shared 变量初始化的位置
if (!sharedChildSessions) sharedChildSessions = new Set<string>()
if (!sharedAbortedChildren) sharedAbortedChildren = new Set<string>()
```

### P3: session.created 事件

```typescript
// src/index.ts event hook 内，现有 session.deleted 处理之前
if (event.type === "session.created") {
    const info = (event.properties as any)?.info
    if (info?.parentID) {
        sharedChildSessions!.add(event.properties!.sessionID!)
        logger.debug("session.child_detected", {
            sessionID: event.properties!.sessionID,
            parentID: info.parentID,
        })
    }
}
```

### P4: 子会话 reactive handler

```typescript
// src/actions/reactive.ts handleReactiveEvent 函数
// 在 shouldIntervene gate 之后、get messages 之前插入：

// 子会话分支：abort-only，不走 revert+prompt
if (ctx.childSessions?.has(sessionID)) {
    // ⑥ Record failure
    const cached = findCachedEntry(ctx.messageCache, sessionID, lastUserMessageID)
    if (cached) {
        const currentModelKey = cached.modelKey
        ctx.store.recordFailure(currentModelKey)
        ctx.logger.info("reactive.child_failure_recorded", {
            sessionID,
            model: currentModelKey,
            score: ctx.store.get(currentModelKey),
            category: classification.category,
        })
    }
    // ⑦ Abort without revert/prompt — onInterrupt handles cleanup
    ctx.abortedChildren?.add(sessionID)
    await ctx.client.session.abort({ path: { id: sessionID } })
    ctx.logger.info("reactive.child_aborted", { sessionID })
    return
}
```

需要新增 `ReactiveContext` 字段：
```typescript
interface ReactiveContext {
    // ... existing fields ...
    childSessions?: Set<string>
    abortedChildren?: Set<string>
}
```

### P5: tool.execute.after hook

```typescript
// src/index.ts server() 返回对象中新增
"tool.execute.after": async (input: any, output: any) => {
    if (input.tool !== "task") return

    const metadata = output.metadata as Record<string, unknown> | undefined
    const childSessionID = metadata?.sessionId as string | undefined
    if (!childSessionID) return

    if (!sharedAbortedChildren?.has(childSessionID)) return
    sharedAbortedChildren.delete(childSessionID)

    const currentOutput = String(output.output || "")
    // model info lives in metadata, not args
    const modelInfo = metadata?.model as { providerID?: string; modelID?: string } | undefined
    const modelName = modelInfo ? `${modelInfo.providerID}/${modelInfo.modelID}` : "模型"

    output.output = [
        currentOutput,
        "",
        "---",
        `⚠️ 子会话 ${childSessionID} 因 ${modelName} 429 限流中断`,
        `重试时请在新子会话中执行: opencode export ${childSessionID} 2>&1 | tail -200`,
        `查看方法: 看第一句(任务目标) + 最后几句(已完成的工作)`,
    ].join("\n")

    logger.info("tool.after.task_enhanced", {
        parentSessionID: input.sessionID,
        childSessionID,
    })
}
```

## 测试计划

### 单元测试

| 测试 | 覆盖 |
|------|------|
| session.created → parentID 非空 → childSessionSet 记录 | P3 |
| session.created → parentID 为空 → 不记录 | P3 |
| reactive → 子会话 → recordFailure + abort | P4 |
| reactive → 主会话 → 原有逻辑不变 | P4 |
| tool.execute.after → task+aborted child → 增强输出 | P5 |
| tool.execute.after → task+non-aborted → 跳过 | P5 |
| tool.execute.after → 非 task tool → 跳过 | P5 |

### E2E 测试（SDK server）

| 测试 | 目的 |
|------|------|
| 子会话 429 → abort → task 不 hang | 验证 onInterrupt 正确返回 |
| 子会话 429 → task 输出含 session ID | 验证 tool.execute.after 生效 |
| 新子会话读旧会话 → 能正常继续 | 验证 opencode export 可用 |
| preemptive 切换 → 第二次 dispatch 用 v4-flash | 验证健康分传播 |

### Mock LLM Server 测试（真实进程）

| 测试 | 目的 |
|------|------|
| Mock 返回 429 → reactive 触发 → task 正常结束 | 全链路验证 |
| Mock 返回 200 → preemptive 直接切 | 验证正常流程不受影响 |

## 回滚方案

如果出现问题，只需：
1. 删除 P3-P5 的新增代码
2. 恢复 reactive handler 为旧逻辑

改动集中在 3 个点，无数据库变更，无配置文件变更。

## 实施顺序

```
P1 → P2 → P3 → 单元测试 → P4 → 单元测试 → P5 → E2E 测试 → 真实进程测试
```

## 需要校验的点（在校验阶段确认）

- [ ] `session.created` event.properties.info.parentID 在运行时确实非空
- [ ] `tool.execute.after` 的 input.sessionID 是父会话还是子会话
- [ ] `tool.execute.after` 的 output.output 修改是否生效
- [ ] `output.metadata.sessionId` 在 task 返回中确实存在
- [ ] abort 后 `lastAssistant` 是否能正常读取消息并返回（不 revert 时）
- [ ] `opencode export` 在新子会话中是否可执行
- [ ] `recordFailure` 的模型 key 与 cache 中的一致
