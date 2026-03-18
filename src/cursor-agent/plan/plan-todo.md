# Cursor Agent Compatibility Plan

## Confirmed Gaps

### P0. 缺少 OpenAI 那种实时流式事件对齐

现状：

- `openai-ws-stream.ts` 会发 `start`、`text_delta` 等事件。
- `cursor-agent-stream.ts` 现在只在结尾统一 `done`，中间只是本地累积 `fullText` / `thinkingText`。

证据：

- `src/agents/openai-ws-stream.ts:624-697`
- `src/cursor-agent/cursor-agent-stream.ts:732-889`

影响：

- `onPartialReply`、`blockReplyChunking`、长回复渐进输出体验都拿不到真正增量。
- `thinkingDelta` 已经从 Cursor 收到了，但 OpenClaw 侧没有实时透出 reasoning stream。
- 长任务时前端/消息通道会更像“卡住后一次性出结果”。

TODO：

- 在 Cursor stream 开始时补发 `start` 事件。
- 将 `interactionUpdate.textDelta` 映射为 `text_delta`。
- 将 `interactionUpdate.thinkingDelta` 映射到现有 reasoning 流机制，或补一层兼容事件。
- 为 partial reply / reasoning stream 增加 e2e 用例。

### P1. OpenResponses hosted tools 语义还没和 OpenAI 路径完全对齐

现状：

- `toClientToolDefinitions(...)` 会返回一个 `pending` 的伪工具结果，并记录 `clientToolCallDetected`。
- 这套语义是按 OpenResponses hosted tools 设计的。
- 但 Cursor 路径会通过 MCP / shell bridge 真正调用 `tool.execute(...)`，因此模型会先看到一个“pending 工具结果”，而不是像 OpenAI Responses 那样在 transport 层停下来等待客户端执行。

证据：

- `src/agents/pi-tool-definition-adapter.ts:196-233`
- `src/agents/pi-embedded-runner/run/attempt.ts:920-944`
- `src/agents/pi-embedded-runner/run/attempt.ts:1720-1723`
- `src/cursor-agent/cursor-agent-stream.ts:1089-1444`

影响：

- `/v1/responses` 的 hosted tools 语义在 Cursor backend 下可能与 OpenAI backend 不一致。
- 可能出现“模型已经收到一个 pending 工具输出，但外部客户端还没真正执行工具”的偏差。

TODO：

- 明确 Cursor backend 是否要支持 OpenResponses hosted tools。
- 如果支持，需要改成“检测到 client tool 后中断并向上返回 pending tool call”，而不是把 pending 结果继续喂回模型。
- 如果暂时不支持，需要在 Cursor backend 上显式禁用或报错。
- 补一条 `/v1/responses + clientTools + cursor/default` 的端到端测试。

### P2. 会话历史没有清理 Cursor `<think>` 标签

现状：

- Cursor bridge 会把 `thinkingText` 包成 `<think>...</think>` 存回 assistant content。
- `session-state.ts` 在抽取 assistant 历史时，没有去掉这些 reasoning tags。

证据：

- `src/cursor-agent/cursor-agent-stream.ts:875-879`
- `src/cursor-agent/session-state.ts:148-152`

影响：

- 旧轮次的内部思考可能被原样拼回 `promptWithHistory`。
- `.cursor/session-history/*.md` rule 里也会混入 `<think>` 内容。
- 这会让后续 Cursor 回合拿到不必要的推理噪音。

TODO：

- assistant 历史抽取时调用统一的 reasoning-tag stripping helper。
- 区分“用户可见文本”和“内部 reasoning 标签文本”。
- 为 session-history rule 补回归测试。

### P2. Cursor 协议分支覆盖还不完整

现状：

- 当前 bridge 只处理了一部分 `execServerMessage`。
- 未处理分支会直接 `cursor-unhandled-esm` 后关闭。
- 某些 interaction query 仍然是显式 reject / unsupported。

证据：

- `src/cursor-agent/cursor-agent-stream.ts:1026-1444`
- `src/cursor-agent/cursor-agent-stream.ts:1447-1488`

当前明显缺口：

- `backgroundShellSpawnArgs`
- `writeShellStdinArgs`
- `computerUseArgs`
- `recordScreenArgs`
- `executeHookArgs`
- `switchModeRequestQuery`
- `askQuestionInteractionQuery`
- `setupVmEnvironmentArgs`

影响：

- 一些 Cursor 原生工作流会退化或失效。
- 现在更多是“桥接能跑主链路”，还不是“协议能力完整覆盖”。

TODO：

- 先确认 OpenClaw 需要支持的 Cursor 协议子集。
- 对需要的分支补实现。
- 对不打算支持的分支，显式下调 capability advertisement，避免 Cursor 误用。

## Suggested Order

1. 先补认证链路，不然 Cursor 接入本身就不稳定。
2. 再补流式事件与 usage / stopReason，不然 OpenClaw 上层体验和监控都不准。
3. 之后处理 hosted tools 语义与 generation params，这两项直接影响 gateway / 配置兼容性。
4. 最后补历史清洗和协议剩余分支。
