# Cursor Agent Provider Parity Plan

> 这个文档只比较 `src/cursor-agent` 与 `ollama` 接入方式在 OpenClaw 体系内的差距。
> 已有的 `plan-todo.md` 更偏 Cursor 协议桥接本身；这里补的是 provider / auth / config / onboarding / docs / tests 这一层。

## 已确认差距

### P0. 认证链路没有像 Ollama 一样真正接入 OpenClaw 的 provider 体系

现状：

- `src/agents/model-auth.ts` 已经认识 `CURSOR_ACCESS_TOKEN`。
- 但 `src/agents/models-config.providers.ts` 会无条件注册 `providers.cursor`，并写死 `apiKey: "cursor-builtin"`。
- `src/agents/pi-embedded-runner/run/attempt.ts` 真正启动 Cursor 时，直接传 `DEFAULT_CURSOR_CREDENTIALS`，没有走 auth storage / env / config。
- `src/cursor-agent/cursor-agent-stream.ts` 请求地址也直接写死为 `AGENT_API = "https://agent.api5.cursor.sh"`。
- 代码搜索里，`CURSOR_MACHINE_ID` / `CURSOR_MAC_MACHINE_ID` 只出现在 `src/agents/pi-embedded-runner/model.ts` 的提示文案里；当前没有实际读取链路。这一点是根据本次代码搜索得到的推断。

对照 Ollama：

- `src/agents/models-config.providers.ts` 会从 env / auth profile / explicit provider 解析 Ollama。
- `src/agents/pi-embedded-runner/run/attempt.ts` 会把 `model.baseUrl` / `provider.baseUrl` 传给 `createOllamaStreamFn(...)`。
- `src/agents/ollama-stream.ts` 运行时会消费 `options.apiKey` / `options.headers`。

影响：

- `CURSOR_ACCESS_TOKEN`、auth profile、`models.providers.cursor.apiKey`、`models.providers.cursor.baseUrl` 目前都没有真正成为 Cursor 运行时来源。
- 无法像 Ollama 一样支持 remote / proxy / 自定义 baseUrl 覆盖。
- machine id / mac machine id 在 OpenClaw 里只是“文案上支持”，不是“链路上支持”。
- 现在的接入更像“内置开发凭据直连 Cursor 服务”，而不是“OpenClaw 兼容 provider”。

TODO：

- 增加 `resolveCursorCredentials(...)`，把 env / auth profile / config 统一收敛成 `CursorAgentCredentials`。
- 在 `run/attempt.ts` 中把 `model.baseUrl` / provider config 传进 Cursor stream，而不是只用常量。
- 为 Cursor auth profile 约定 metadata 字段，承载 `machineId` / `macMachineId`。
- 把 `DEFAULT_CURSOR_CREDENTIALS` 降级为仅开发环境 fallback，或彻底移除。
- 补一组 end-to-end / unit tests，覆盖 auth 优先级和 baseUrl 生效链路。

### P1. OpenClaw 通用 stream options / extra params 没有透传到 Cursor

现状：

- `src/agents/pi-embedded-runner/extra-params.ts` 会给 streamFn 包装通用参数，例如 `temperature`、`maxTokens`、`headers`。
- `src/agents/ollama-stream.ts` 会消费 `options.temperature`、`options.maxTokens`、`options.headers`、`options.apiKey`、`options.signal`。
- 但 `src/cursor-agent/cursor-agent-stream.ts` 的 streamFn 形态是 `(model, context, _streamOptions)`，`_streamOptions` 现在完全没用。

影响：

- `agents.defaults.models["cursor/..."].params.*` 这一套 OpenClaw 公共模型参数，对 Cursor 现在大概率是静默失效。
- 即使上层 wrapper 注入了自定义 headers / transport / 其他运行时选项，Cursor 路径也不会消费。
- 从用户视角看，Cursor provider 的配置行为会和其他 provider 不一致，而且没有显式报错。

TODO：

- 先确认 Cursor 协议里哪些 generation params 真能下发，哪些根本不支持。
- 对能支持的参数补透传。
- 对明确不支持的参数，至少在 Cursor provider 上显式忽略并记录 warning，不要静默吞掉。
- 补一组对照测试，至少覆盖 `signal`、`temperature`、`maxTokens`、`headers` 是否生效或是否被显式拒绝。

### P1. onboarding / secrets / configure 还没有 Cursor 的一等入口

现状：

- `src/secrets/provider-env-vars.ts` 里有 `OLLAMA_API_KEY`，但没有 `CURSOR_ACCESS_TOKEN` / `CURSOR_MACHINE_ID` / `CURSOR_MAC_MACHINE_ID`。
- `src/commands/auth-choice-options.ts` 和 `src/commands/onboard-types.ts` 没有 Cursor 相关 auth choice / group。
- `src/commands/auth-choice.apply-helpers.ts` 在 `--secret-input-mode ref` 下会依赖 `PROVIDER_ENV_VARS` 自动推断 env var；Cursor 现在没有这条映射。
- `src/cli/config-cli.ts` 对 `models.providers.ollama.apiKey` 有自动补全 provider 结构的 helper，但 Cursor 没有类似配置引导。

影响：

- `openclaw configure` / onboarding 流程里，Cursor 不是一等 provider，用户只能走更底层、更通用的手工路径。
- secrets ref 模式下，Cursor 会缺少默认 env var 建议，甚至直接报 `No default environment variable mapping found for provider "cursor"`。
- secrets audit / apply / configure 这套围绕 provider env var 的体验，对 Cursor 目前是不完整的。

TODO：

- 把 Cursor 相关 env vars 接进 `PROVIDER_ENV_VARS`。
- 给 Cursor 增加最小可用的一等 auth/onboarding 入口。
- 评估是否需要 `config set models.providers.cursor.apiKey` / `baseUrl` 的自动补全 helper。
- 让 onboarding / secrets ref 流程能同时处理 token 和 machine ids。

### P2. 文档与 provider 可发现性没有补齐

现状：

- `docs/providers/ollama.md`、`docs/zh-CN/providers/ollama.md`、providers index、model providers 概览页都已经有 Ollama。
- 本次代码搜索没有发现对应的 `docs/providers/cursor.md`、中文文档、providers index 条目、`docs/docs.json` 导航项。

影响：

- 即使代码里已经能选 `cursor/default`，用户也没有官方的配置说明、鉴权说明、限制说明和排障入口。
- 这会放大上面的 auth / config 缺口，因为用户根本不知道当前支持到哪一层。

TODO：

- 新增中英文 Cursor provider 文档。
- 在 providers index / model providers 概览页中加入 Cursor。
- 文档里明确写清：认证方式、是否支持自定义 baseUrl、是否支持 machine ids、哪些 OpenClaw 参数当前无效。

### P2. provider 层回归测试明显少于 Ollama

现状：

- Ollama 已经有较完整的 provider 级测试：`src/agents/ollama-stream.test.ts`、`src/agents/models-config.providers.ollama.test.ts`、`src/agents/models-config.providers.ollama-autodiscovery.test.ts`、`src/cli/config-cli.test.ts`。
- Cursor 目前看到的测试主要集中在 `src/cursor-agent/cursor-agent-stream.test.ts`、`src/cursor-agent/session-state.test.ts`、`src/cursor-agent/mcp-tool-bridge.test.ts`、`src/cursor-agent/request-context-rules.test.ts`。
- 也就是说，Cursor 更偏“桥接内部单测”，还缺少 provider 配置、auth、生效链路这类 parity test。

影响：

- 只要后面去改 auth/config/baseUrl/extra params，很容易出现“看起来接上了，实际上 runner 没吃到”的回归。
- 现在很难像 Ollama 那样证明“provider 行为已经和 OpenClaw 主链路兼容”。

TODO：

- 新增 `models-config.providers.cursor*.test.ts`，覆盖 implicit/explicit provider 合并行为。
- 新增 runner 侧测试，覆盖 Cursor credentials / baseUrl / stream options 是否真的传入 streamFn。
- 新增 CLI / onboarding / secrets 侧测试，覆盖 Cursor env var 与 auth choice 入口。

## 建议顺序

1. 先补 P0 认证与 baseUrl 链路，不然现在的 Cursor 更像一条旁路，不是 OpenClaw provider。
2. 再补 P1 的 stream options / extra params，不然公共模型配置对 Cursor 仍然不可信。
3. 然后补 onboarding / secrets / configure，一旦功能可用，就需要用户能真正配置起来。
4. 最后补文档和回归测试，把这条接入正式纳入 OpenClaw 的长期维护面。

## 与现有 plan 的关系

以下问题已经在 `src/cursor-agent/plan/plan-todo.md` 里记录，这里不重复展开：

- 流式事件对齐（`start` / `text_delta` / reasoning stream）
- usage / stopReason
- hosted tools 语义
- `<think>` 历史清理
- Cursor 协议剩余分支覆盖

这份 `plan-ollama.md` 可以理解为：在 `plan-todo.md` 之外，专门补“像 Ollama 那样接进 OpenClaw provider 体系”还缺什么。
