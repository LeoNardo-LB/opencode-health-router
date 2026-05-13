# 设计文档：子会话 429 限流恢复

## 1. 问题定义

当子会话（subagent/task session）遇到 429 Rate Limit 时，health-router 的 reactive handler
执行 `abort() + revert() + prompt()` 三件套，会破坏 OpenCode 的 task（父子会话）生命周期，
导致父会话永久 hang 死（task status = running 永不返回）。

### 1.1 症状

- 子会话在 health-router 介入后能正常完成（用 fallback 模型）
- 但父会话的 task 工具永远等不到返回结果
- task part status 保持 `running`，父会话 hang 死

### 1.2 影响范围

仅影响 subagent（task 工具派发的子会话）。主会话不受影响，因为主会话没有 task 等待链。

### 1.3 根因

OpenCode 的 Runner 机制中，`abort()` 触发 `onInterrupt` 回调（= `lastAssistant`），
`lastAssistant` 从消息流中读取最新 assistant 消息并返回给 task 工具作为 prompt 结果。

reactive handler 的当前流程：

```
abort()   → kill runLoop fiber → onInterrupt = lastAssistant 开始 streaming
revert()  → 删除所有消息        → stream 游标断裂 → lastAssistant 卡住
prompt()  → 创建新消息           → 太晚了，onInterrupt 已死
```

结果：task 工具的 `await SessionPrompt.prompt()` 永远不 resolve → running forever。

## 2. 设计目标

1. 子会话 429 时，task 能正常返回（不 hang）
2. 父会话 AI 能感知失败，并获得足够信息进行重试
3. 重试时 preemptive handler 自动切换到健康分更高的模型
4. 新子会话能读取上一轮的部分工作成果
5. 最小化代码改动，利用现有 SDK 能力

## 3. 方案概述

### 3.1 总体思路

**子会话不再走 reactive 的 `abort+revert+prompt` 三件套，改为 `abort-only`。**
利用 OpenCode 原生 `onInterrupt` 机制让 task 正常返回，
再通过 `tool.execute.after` hook 增强 task 输出（附加会话 ID + 使用说明）。

### 3.2 三个切入点的职责

```
┌─────────────────────────────────────────────────────────────┐
│ ① session.created 事件                                       │
│    职责：检测子会话，维护 childSessionSet                      │
│    SDK：event hook → EventSessionCreated                    │
│    API：event.properties.info.parentID (非空 = 子会话)        │
├─────────────────────────────────────────────────────────────┤
│ ② reactive handler（session.status retry 事件）               │
│    职责：子会话 → recordFailure + abort（不 revert，不 prompt）│
│    SDK：client.session.abort({ path: { id: sessionID } })   │
│    机制：abort 触发 Runner.onInterrupt → task 正常返回        │
├─────────────────────────────────────────────────────────────┤
│ ③ tool.execute.after hook                                   │
│    职责：检测 task 失败 → 增强输出（附 session ID + 使用说明）  │
│    SDK：tool.execute.after → 修改 output.output              │
│    数据源：output.metadata.sessionId = 子会话 ID             │
└─────────────────────────────────────────────────────────────┘
```

### 3.3 完整数据流

```
父会话 dispatch task(description="Discover auth", subagent="general")
    │
    ▼
子会话 ses_A 创建
    │ session.created event → parentID 非空 → 记入 childSessionSet
    │
    ▼
chat.message hook → preemptive 检查:
    glm-5-turbo(100) vs v4-flash(100) → no_switch → 用 glm-5-turbo
    │
    ▼
LLM 请求 glm-5-turbo → 429 → OpenCode 自动重试(attempt 1,2,3) → 全部 429
    │
    ▼
session.status retry event (attempt 4 > maxRetries 3)
    │
    ▼
reactive handler ─→ isChild? YES
    ├─ store.recordFailure("zhipuai-coding-plan/glm-5-turbo")     → score 100→80
    ├─ client.session.abort({ path: { id: ses_A } })
    │    │
    │    └─ Runner.cancel → Fiber.interrupt → Deferred.fail(Cancelled)
    │         → .catch → onInterrupt = lastAssistant(ses_A)
    │         → MessageV2.stream(ses_A) → 最新 assistant = 429 error msg
    │         → return → task 拿到空/错误结果 → task completed
    │
    └─ 不 revert，不 prompt ← 关键差异

    ▼
tool.execute.after hook 触发
    input.tool = "task"
    input.sessionID = 父会话ID
    output.metadata.sessionId = ses_A  ← 子会话 ID
    │
    ├─ 检查 ses_A 是否在 abortedChildSessions 中 → YES
    ├─ 构建增强输出
    └─ output.output += "\n⚠️ 限流中断…\n上一轮会话: ses_A\n重试时用 opencode export ses_A 查看进度"

    ▼
父会话 AI 收到 task 结果:
    <task_result>
    ⚠️ 子会话因 glm-5-turbo 429 限流中断
    上一轮会话 ID: ses_A
    重试时请用 opencode export ses_A 2>&1 | tail -200
    查看第一句任务目标和最后几句已完成的工作
    </task_result>

    ▼
父会话 AI 决定重试:
    task(description="Continue auth", subagent="general",
         prompt="上一轮因限流中断(ses_A)。
                 请先执行: opencode export ses_A 2>&1 | tail -200
                 看第一句(任务)和最后几句(成果)。
                 然后继续未完成的工作。")

    ▼
新子会话 ses_B:
    ├─ bash: opencode export ses_A → 读到目标和进展
    ├─ chat.message hook → preemptive:
    │     glm-5-turbo(80) < v4-flash(100) → SWITCH! → 用 v4-flash
    └─ v4-flash 正常执行 → finish=stop → task completed ✅
```

## 4. 关键设计决策

### 4.1 为什么用 `opencode export` 而不写文件

| 方案 | 优点 | 缺点 |
|------|------|------|
| 写文件供读取 | 快 | 污染项目目录，需清理 |
| 总结 agent 生成 | 裁剪好 | 额外模型调用，可能也限流 |
| `opencode export` | 零额外依赖，内容完整 | 需新子会话执行 bash |

选择 `opencode export`：
- 零外部依赖，零额外模型调用
- 内容完整天然裁剪（只看头尾，工具调用噪音自动跳过）
- 新子会话自助读取，不消耗主会话上下文

### 4.2 为什么用 `tool.execute.after` 而不是其他方式

| 方式 | 可行性 |
|------|--------|
| 修改 task 工具源码 | ❌ 不可改 OpenCode |
| 写文件让 AI 读 | 可行但需 AI 主动 |
| `tool.execute.after` | ✅ 直接增强 task 输出，AI 必见 |

`tool.execute.after` 是 OpenCode 在 task 完成后调用的 hook，
可以修改 `output.output`（最终展示给 LLM 的文本）。
通过它注入会话 ID 和使用说明，父会话 AI 必然看到。

### 4.3 为什么不 revert

revert 会删除消息，导致 `onInterrupt` 的 `MessageV2.stream()` 游标断裂。
不 revert 时，消息完好，`lastAssistant` 能快速返回（微秒级），task 正常完成。

### 4.4 为什么不 prompt

1. Runner 有 `assertNotBusy` 检查 → prompt 会抛 `BusyError`
2. 即使先 abort 再 prompt，`onInterrupt` 也已返回 → task 已结束 → prompt 无意义

### 4.5 健康分传播

子会话的 `recordFailure` 会降低模型健康分（100→80）。
因为 health-router 使用 module-level shared state，所有会话共享同一 HealthStore。
下一次 dispatch 时，preemptive handler 看到降分后的模型 → 自动切换。

## 5. 组件变更

### 5.1 新增状态

| 变量 | 类型 | 用途 |
|------|------|------|
| `sharedChildSessions` | `Set<string>` | 子会话 ID 集合 |
| `sharedAbortedChildren` | `Set<string>` | 已被 abort 的子会话 ID |

### 5.2 修改的 hook

| Hook | 变更 | 代码行数 |
|------|------|---------|
| `event` (session.created) | 新增：记录子会话 | +5 |
| `event` (session.status retry) | 修改：子会话 skip revert+prompt | +5 |
| `tool.execute.after` | 新增：增强 task 输出 | +20 |

### 5.3 文件变更

| 文件 | 变更类型 |
|------|---------|
| `src/index.ts` | 修改 |
| `src/actions/reactive.ts` | 修改 |
| 无新文件 | — |
