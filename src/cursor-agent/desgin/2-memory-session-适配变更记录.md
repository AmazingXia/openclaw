# OpenClaw 接入 Cursor Agent 会话记忆变更记录

日期：2026-03-10

参考文档：`src/cursor-agent/desgin/1-桥接openclaw和cursor.md`

## 1. 背景

`1-桥接openclaw和cursor.md` 主要解决的是 **OpenClaw 工具体系如何桥接到 Cursor Agent**：

1. 通过 `requestContext.rules` 暴露 OpenClaw 工具
2. 通过 shell 拦截把 Cursor 的工具调用转回 OpenClaw `tool.execute()`

但该文档没有覆盖另一个关键问题：

**Cursor Agent 的会话连续性如何接入 OpenClaw 现有的 `SessionManager`。**

在 `cursor-client` 的实现里，会话连续性依赖以下几个字段：

1. `conversationId`
2. `conversationState`
3. `notesSessionId`
4. `history`

其中真正决定“上一轮上下文是否能恢复”的核心，不是 `notesSessionId` 本身，而是：

1. 后续请求是否继续复用同一个 `conversationId`
2. 后续请求是否回传服务端流式下发的 `conversationCheckpointUpdate`
3. 当 `conversationState` 缺失时，客户端是否提供最近历史作为 fallback

## 2. 改造目标

本次改造目标是把 Cursor 的会话记忆链路嵌入 OpenClaw，而不是照搬 `cursor-client` 的本地 `.json` 文件实现。

具体目标：

1. 复用 OpenClaw 的 `SessionManager` 做会话状态持久化
2. 在 Cursor 请求里持续复用 `conversationId` 与 `conversationState`
3. 在 `requestContextArgs` 时把最近会话历史注入为一条规则
4. 在没有 checkpoint 的场景下，仍能通过历史 prompt fallback 给 Cursor 最近上下文
5. 尽量不破坏现有 Cursor 工具桥接逻辑

## 3. 两套会话模型的差异

### 3.1 Cursor Client 的模型

`cursor-client` 是一个独立客户端，因此需要自己维护本地会话文件：

1. 启动时从本地 JSON 读取状态
2. 发请求时把 `conversationState` 带回 `runRequest`
3. 流式过程中接收 `conversationCheckpointUpdate`
4. 把最新 checkpoint 重新落盘
5. 当 checkpoint 不可用时，把最近 history 注入 prompt

### 3.2 OpenClaw 的模型

OpenClaw 已经有完整的会话系统：

1. `SessionManager` 负责 transcript 持久化
2. `context.messages` 已经包含当前会话的消息链
3. `attempt.ts` 在创建 agent session 时已经拿到 `sessionManager`
4. OpenClaw 本身已经处理分支、上下文恢复、会话文件等问题

### 3.3 结论

因此最佳方案不是新增一个 `.cursor-client.session.json`，而是：

**把 Cursor 的会话状态作为 `SessionManager` 的自定义 entry 持久化，同时从 OpenClaw 现有消息链中提取最近历史。**

## 4. 最终方案

### 4.1 新增 Cursor Session 适配层

新增文件：

- `src/cursor-agent/session-state.ts`

该模块负责：

1. 从 `SessionManager` 的 custom entry 中加载 Cursor 会话状态
2. 保存 `conversationId / conversationState / notesSessionId / workspaceId`
3. 从 OpenClaw `context.messages` 提取最近用户/助手历史
4. 构建 prompt fallback
5. 构建 `requestContext` 用的 session-history rule

### 4.2 状态存储位置

使用 `SessionManager.appendCustomEntry(...)` 持久化，`customType` 为：

```ts
openclaw: cursor - agent - session - state;
```

持久化字段：

1. `conversationId`
2. `conversationState`
3. `notesSessionId`
4. `workspaceId`
5. `updatedAt`

注意：

1. `history` 不单独持久化到 custom entry
2. `history` 直接从当前 OpenClaw 的 `context.messages` 现算
3. 这样可以减少重复存储，也能避免维护两套消息源

### 4.3 prompt fallback

当 `conversationState` 为空时，适配层会从最近消息中抽取历史，并把它包装成：

```xml
<previous_conversation>
...
</previous_conversation>

<current_user_message>
...
</current_user_message>
```

这样即使 Cursor 服务端没有可恢复的 checkpoint，也能拿到最近对话上下文。

### 4.4 requestContext 历史规则

在 `execServerMessage.requestContextArgs` 分支中：

1. 读取 `notesSessionId`
2. 读取 `workspaceId`
3. 更新本地适配层状态
4. 生成一条 `.cursor/session-history/<session>.md` 风格的 rule
5. 将该 rule 与已有 system prompt / tools rules 一起返回给 Cursor

这与 `cursor-client` 的思路一致，但数据来源改为 OpenClaw 当前会话。

### 4.5 checkpoint 回写

在 Cursor 流式消息中新增对以下字段的处理：

1. `conversationCheckpointUpdate`
2. `conversationCheckpoint`

处理方式：

1. 收到 checkpoint 后立即更新内存状态
2. 同步写入 `SessionManager` custom entry
3. 在 `turnEnded` 时再写一次，降低状态丢失风险
4. 在 HTTP 流结束时再补一次写入

## 5. 代码变更点

### 5.1 `src/cursor-agent/session-state.ts`

新增能力：

1. `loadCursorSessionState()`：从 `SessionManager` 读取最近的 Cursor 状态
2. `extractHistoryFromMessages()`：从 OpenClaw 消息中提取历史
3. `buildPromptWithHistory()`：构建 fallback prompt
4. `buildSessionHistoryRule()`：构建 history rule
5. `createCursorSessionBridge()`：统一封装状态读写与会话桥接逻辑

### 5.2 `src/cursor-agent/cursor-agent-stream.ts`

主要调整：

1. 创建 `sessionBridge`
2. 请求开始前复用已有 `conversationId`
3. 请求开始前复用已有 `conversationState`
4. 使用 `promptWithHistory` 替换原始 prompt
5. 在 `requestContextArgs` 中接入 `notesSessionId/workspaceId/historyRule`
6. 在流式阶段接收 checkpoint 并回写状态
7. 在结束阶段补做 checkpoint 持久化

### 5.3 `src/agents/pi-embedded-runner/run/attempt.ts`

新增改动：

1. 在 `createCursorAgentStreamFn(...)` 时，把 OpenClaw 的 `sessionManager` 传入 Cursor stream

这一步是整个集成真正打通的关键入口。

## 6. 数据流变化

改造前：

```text
OpenClaw prompt
  -> Cursor runRequest(conversationState = {})
  -> Cursor 输出结果
  -> 下一轮重新 random conversationId
```

结果：

1. Cursor 认为每轮都是新会话
2. 即使 `notesSessionId` 相同，也不一定恢复到上一轮状态

改造后：

```text
SessionManager
  -> 加载最近 Cursor 状态
  -> Cursor runRequest(conversationId + conversationState)
  -> Cursor 流式下发 checkpoint
  -> SessionManager custom entry 持久化 checkpoint
  -> 下一轮继续复用 conversationId + conversationState
  -> 若 checkpoint 为空，则使用 OpenClaw history fallback
```

结果：

1. 会话连续性从“单轮新建”变成“跨轮复用”
2. 会话恢复不再只依赖 `notesSessionId`
3. OpenClaw 与 Cursor 的记忆系统开始融合到同一条会话链路中

## 7. 验证情况

新增测试文件：

- `src/cursor-agent/session-state.test.ts`

覆盖内容：

1. 能从 OpenClaw 用户消息中剥离 metadata 前缀
2. 能从消息链中提取最近 history
3. 当 `conversationState` 不存在时，会注入 prompt fallback
4. 能通过 `SessionManager` custom entry 加载与更新 Cursor 状态

执行命令：

```bash
corepack pnpm exec vitest run src/cursor-agent/session-state.test.ts
```

结果：

1. 测试通过

附加校验：

```bash
corepack pnpm exec tsx -e "(async () => { await import('./src/cursor-agent/session-state.ts'); await import('./src/cursor-agent/cursor-agent-stream.ts'); console.log('cursor-agent syntax ok'); })().catch((err) => { console.error(err); process.exit(1); });"
```

结果：

1. 语法导入通过

说明：

仓库全量 `tsc` 仍存在其他既有报错，不属于本次改动引入。

## 8. 当前限制

当前实现已经解决“把 Cursor 会话状态接进 OpenClaw”这个主问题，但还有几个限制：

1. 当前状态是按 OpenClaw session 持久化，不是按 `workspaceId + notesSessionId` 建独立索引
2. `history` 采用消息级裁剪，还没有做 token 级裁剪
3. 目前只持久化 Cursor 自身状态，没有把 Cursor 的内部 summary 结构做更细粒度解释或映射
4. 如果后续要支持同一个 OpenClaw session 内部切多个 Cursor 逻辑会话，还需要进一步做 key 设计

## 9. 后续建议

建议下一步继续做三件事：

1. 为 Cursor 会话状态增加更细的 key 维度，至少考虑 `workspaceId + notesSessionId`
2. 增加端到端日志验证，确认多轮请求稳定复用同一 `conversationId`
3. 根据真实日志观察 `conversationCheckpointUpdate` 的结构，决定是否需要额外做裁剪或摘要

## 10. 总结

这次改造的本质不是“给 Cursor 再加一套记忆文件”，而是：

**把 Cursor 的 `conversationState` 机制，嫁接到 OpenClaw 已有的 `SessionManager` 之上。**

这样做的收益是：

1. 复用 OpenClaw 已有会话基础设施
2. 避免额外维护一套独立本地状态文件
3. 保持 Cursor 的 checkpoint 机制不变
4. 让 OpenClaw 的消息历史成为 Cursor 会话恢复的 fallback

至此，`1-桥接openclaw和cursor.md` 负责“工具桥接”，本文件负责“会话记忆桥接”，两部分合起来才是完整的 OpenClaw × Cursor Agent 集成方案。
