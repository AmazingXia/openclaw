# 3. MCP Tool 适配变更记录

## 1. 背景

前两篇设计文档分别解决了两个问题：

1. `src/cursor-agent/desgin/1-桥接openclaw和cursor.md`
   - 说明了 OpenClaw 早期如何通过 `rules + openclaw-tool shell bridge` 把工具能力桥接给 Cursor
2. `src/cursor-agent/desgin/2-memory-session-适配变更记录.md`
   - 说明了如何把 Cursor 会话状态接入 OpenClaw 的 session / memory 体系

在这两个基础上，当前还差一层能力：

1. Cursor 服务端已经支持原生 MCP 工具调用链路
2. OpenClaw 自身也已经有一套运行时 tools
3. 但两者之间原先没有真正打通，仍主要依赖 shell bridge

本次改造的目标，就是把 OpenClaw 自身的 runtime tools 适配成 Cursor 可识别、可调用的 MCP tools。

参考设计：

1. `cursor-client/design/4-tools-mcp-integration-zh.md`

核心结论：

> 本次不是把 OpenClaw 接到真实外部 MCP server 管理器，而是把 OpenClaw 自身 runtime tools 伪装成一个 Cursor 可识别的 MCP provider。

## 2. 原问题

改造前，OpenClaw tools 走的是这条链路：

```text
context.tools
  -> buildToolRules(...)
  -> 注入 requestContext.rules
  -> 模型输出 openclaw-tool ...
  -> shellArgs / shellStreamArgs 拦截
  -> 执行真实工具
```

这个方案能工作，但存在几个明显问题：

1. Cursor 原生的 `mcpArgs` / `listMcpResourcesExecArgs` / `readMcpResourceExecArgs` 链路没有被利用
2. OpenClaw tool 对 Cursor 来说仍然像“提示词约定出来的 shell 命令”，不是正式的 MCP tool
3. 工具 schema、定义文件、资源读取等能力无法按 Cursor MCP 约定对齐
4. 后续如果 Cursor 服务端优先走原生 MCP，shell bridge 会越来越像兼容分支而不是主链路

还有一个容易误解的点：

1. `src/agents/pi-embedded-runner/run/attempt.ts` 里运行时工具来自 `createOpenClawCodingTools(...)`
2. 这些运行时对象在内存中是带 `execute(...)` 方法的
3. 但像 `openclaw/.aaaaaaa/mcp-tool/toolsRaw.json` 这类 JSON dump 只会保留可序列化字段
4. 所以其中看不到 `execute`，并不代表工具不可执行，只是 JSON 序列化丢失了函数字段

也就是说：

> `toolsRaw.json` 中看不到 `execute` 并不代表工具不可执行，只是 JSON 序列化丢失函数字段。

## 3. 适配目标

本次适配希望满足下面几点：

1. Cursor 在构建 `requestContext` 时，能直接看到 OpenClaw tools 的 MCP 形态
2. Cursor 服务端回调 `mcpArgs` 时，能够直接命中 OpenClaw runtime tool 并执行
3. Cursor 如果请求列出 / 读取 MCP resources，也能读到 OpenClaw 工具定义
4. 原有 `openclaw-tool` shell bridge 不立即删除，而是保留为兼容 / 兜底路径

最终策略是：

1. **原生 MCP 路径优先**
2. **shell bridge 保留兜底**

即：

> Cursor 走原生 `mcpArgs` 时，优先进入 `mcp-tool-bridge`；原有 `openclaw-tool` shell bridge 保留为兜底路径。

## 4. 方案设计

### 4.1 总体思路

新增桥接层：

1. `src/cursor-agent/mcp-tool-bridge.ts`

它负责把 OpenClaw runtime tools 映射为一个“伪 MCP server”。

关键常量如下：

1. `providerIdentifier`：`openclaw`
2. `serverIdentifier`：`openclaw.tools`
3. 工具定义目录：workspace 下 `.openclaw/cursor-mcp`
4. 虚拟 resource URI 前缀：`openclaw-tool://definition/`

这意味着对 Cursor 来说，OpenClaw tools 会表现为：

1. 来自同一个 MCP provider：`openclaw`
2. 每个 tool 仍保留自己的 plain name
3. 工具 schema 与定义文件都能通过 Cursor 既有结构消费

### 4.2 工具提取与去重

`extractOpenClawTools(...)` 负责从 `context.tools` 中提取工具，并按 `name` 去重。

原因：

1. `context.tools` 是 OpenClaw 运行时上下文，不是纯 MCP 数据结构
2. 里面只要有 `name` 且是对象，就可以先视为候选工具
3. 真正执行时再判断是否存在 `execute`

### 4.3 构造 Cursor MCP 状态

`buildOpenClawMcpState(...)` 会做三件事：

1. 生成 `requestContext.tools`
2. 生成 `mcpInstructions`
3. 生成 `mcpFileSystemOptions.mcpDescriptors`

其中每个运行时工具都会映射成：

1. `name`
2. `providerIdentifier: "openclaw"`
3. `toolName`
4. `description`
5. `inputSchema`

同时还会在 workspace 下写入定义文件：

```text
.openclaw/cursor-mcp/openclaw/tools/<tool>.json
```

这些 JSON 文件内容主要包括：

1. `name`
2. `description`
3. `inputSchema`

这样做的意义是：

1. Cursor 服务端既能看到 tool 元信息
2. 也能通过 `mcpDescriptors.definitionPath` 获取正式定义文件
3. 不需要额外起一个真实 stdio / http MCP server 进程

### 4.4 MCP 参数与返回值归一化

Cursor 回调 `mcpArgs` 时，参数并不一定是普通 JSON，可能是带包装层的 MCP value：

1. `stringValue`
2. `numberValue`
3. `boolValue`
4. `nullValue`
5. `structValue`
6. `listValue`

`mcp-tool-bridge.ts` 里新增了 `normalizeMcpValue(...)` / `normalizeMcpArgs(...)`，把这些结构统一还原成普通 JS 对象。

工具执行完成后，又通过 `normalizeMcpResultContent(...)` 把 OpenClaw 的 tool result 转成 Cursor 期望的 MCP content：

1. 文本内容映射到 `text`
2. 图片内容映射到 `image`
3. 其他对象回退成 JSON 字符串文本

### 4.5 工具执行路由

`execOpenClawMcpTool(...)` 的执行流程如下：

1. 读取 `providerIdentifier`
2. 读取 `toolName` 或 `name`
3. 支持从 `server/tool`、`server:tool`、`server.tool` 这类命名中拆出 provider hint
4. 校验 provider 是否属于 `openclaw` / `openclaw.tools`
5. 找到同名 runtime tool
6. 调用 `tool.execute(randomUUID(), params, signal)`
7. 把结果转换成 `mcpResult.success`

如果 provider 不匹配，或工具不存在，返回 `toolNotFound`。

### 4.6 虚拟 MCP 资源

除了执行 tool，本次还补齐了资源能力：

1. `listOpenClawMcpResources(...)`
2. `readOpenClawMcpResource(...)`

资源不是任意文件，而是**工具定义资源**。

表现形式为：

1. `uri`: `openclaw-tool://definition/<toolName>`
2. `mimeType`: `application/json`
3. `annotations.kind`: `tool-definition`

`readOpenClawMcpResource(...)` 支持两种返回方式：

1. 直接返回 `text`
2. 如果带 `downloadPath`，则把定义文件写到 workspace 相对路径并返回最终路径

## 5. Stream 层接入

### 5.1 `buildRequestContext(...)` 改为异步

在 `src/cursor-agent/cursor-agent-stream.ts` 中，`buildRequestContext(...)` 变成了 `async`。

原因很直接：

1. `buildOpenClawMcpState(...)` 需要写 definition JSON 文件
2. 这一步天然是异步 I/O

因此新的 `requestContext` 除了原来的 `env`、`rules` 外，还新增：

1. `tools`
2. `mcpInstructions`
3. `mcpFileSystemOptions`
4. `supportsMcpAuth: true`

这里仍保留原有的 rules 注入：

1. system prompt rule
2. tool rules
3. history rule

也就是说，现在不是“删掉旧桥接”，而是“在旧桥接之上增加原生 MCP 上报能力”。

### 5.2 新增 MCP exec 回调处理

同文件中新增了三类分支：

1. `mcpArgs`
2. `listMcpResourcesExecArgs`
3. `readMcpResourceExecArgs`

它们分别调用：

1. `execOpenClawMcpTool(...)`
2. `listOpenClawMcpResources(...)`
3. `readOpenClawMcpResource(...)`

这样 Cursor 服务端如果选择走原生 MCP 回调链路，就不再需要退回 shell bridge。

### 5.3 shell bridge 继续保留

虽然原生 MCP 已接通，但这次没有删除老逻辑：

1. `openclaw-tool` 命令前缀仍在
2. `shellArgs` / `shellStreamArgs` 中的拦截逻辑仍在
3. 相关 rule 仍会注入

这样可以保证：

1. 老模型行为不被立刻打断
2. Cursor 服务端如果暂时没有发出 `mcpArgs`，系统仍能工作
3. 新老链路可以并行观察，便于调试与回滚

## 6. 实际数据流

改造后主链路如下：

```text
createOpenClawCodingTools(...)
  -> context.tools
  -> extractOpenClawTools(...)
  -> buildOpenClawMcpState(...)
  -> requestContext.tools
  -> requestContext.mcpInstructions
  -> requestContext.mcpFileSystemOptions
  -> Cursor 服务端识别 OpenClaw MCP provider
  -> 回调 mcpArgs / listMcpResourcesExecArgs / readMcpResourceExecArgs
  -> cursor-agent-stream 分发
  -> mcp-tool-bridge 执行 runtime tool / 返回定义资源
```

兼容链路仍然存在：

```text
context.tools
  -> buildToolRules(...)
  -> 模型输出 openclaw-tool ...
  -> shellArgs / shellStreamArgs 拦截
  -> 执行 runtime tool
```

因此整体结构变成：

1. MCP native path：主路径
2. shell bridge path：兜底路径

## 7. 代码落点

### 7.1 `src/cursor-agent/mcp-tool-bridge.ts`

新增职责：

1. 提取与去重运行时 tools
2. 构建 Cursor 所需的 MCP 状态
3. 把 OpenClaw tool 执行适配到 `mcpArgs`
4. 暴露工具定义 resources
5. 负责参数 / 结果格式归一化

### 7.2 `src/cursor-agent/cursor-agent-stream.ts`

主要变更：

1. `buildRequestContext(...)` 异步化
2. 在 `requestContext` 中上报 MCP 相关字段
3. 增加 `mcpArgs` / `listMcpResourcesExecArgs` / `readMcpResourceExecArgs` handler
4. 保留原有 shell bridge 拦截逻辑

### 7.3 `src/agents/pi-embedded-runner/run/attempt.ts`

作用：

1. 这里仍是 OpenClaw runtime tools 的真实来源
2. 通过 `createOpenClawCodingTools(...)` 创建可执行工具
3. 这些工具最终进入 `context.tools`
4. 再由 Cursor 适配层抽取、包装成 MCP provider

## 8. 验证情况

本次改动已补充针对性的验证。

测试文件：

1. `src/cursor-agent/mcp-tool-bridge.test.ts`
2. `src/cursor-agent/session-state.test.ts`

执行命令：

```bash
corepack pnpm exec vitest run src/cursor-agent/mcp-tool-bridge.test.ts src/cursor-agent/session-state.test.ts
```

结果：

1. 测试通过

附加导入 / 语法校验：

```bash
corepack pnpm exec tsx -e "(async () => { await import('./src/cursor-agent/mcp-tool-bridge.ts'); await import('./src/cursor-agent/session-state.ts'); await import('./src/cursor-agent/cursor-agent-stream.ts'); console.log('cursor-agent mcp syntax ok'); })().catch((err) => { console.error(err); process.exit(1); });"
```

结果：

1. 通过

说明：

1. 仓库全量 `tsc` 仍有其他既有问题
2. 不属于本次 MCP 适配引入

## 9. 当前限制

当前实现已经把 OpenClaw runtime tools 以 Cursor MCP 兼容方式接进来了，但仍有边界：

1. 这不是一个真实的外部 MCP server manager
2. 当前只有一个固定 provider：`openclaw`
3. 当前固定 server identifier：`openclaw.tools`
4. 暴露的 MCP resources 仅限工具定义，不包含更丰富的资源类型
5. `supportsMcpAuth: true` 只是对齐 Cursor requestContext 能力面，本次没有引入真实认证协商
6. shell bridge 仍然保留，说明系统仍处在“新老双路径并存”的兼容阶段

换句话说，这一版解决的是：

1. 让 Cursor **能够原生看见并调用** OpenClaw tools

但还没有扩展到：

1. 多 provider 管理
2. 外部 stdio / http MCP server 生命周期管理
3. 更完整的资源体系与认证体系

## 10. 结论

这次改造把 OpenClaw tools 从“提示词驱动的 shell bridge”提升到了“Cursor 可直接消费的 MCP 兼容工具”。

结果上有三个关键变化：

1. Cursor 可以通过 `requestContext.tools + mcpDescriptors` 原生识别 OpenClaw tools
2. Cursor 服务端下发 `mcpArgs` 时，可以直接路由到 OpenClaw runtime tool 的 `execute(...)`
3. 原有 shell bridge 保留，使迁移过程具备兼容性和可回退性

因此，OpenClaw 与 Cursor 的工具接入形态，从：

```text
rules + shell 命令约定
```

演进成了：

```text
runtime tools -> synthetic MCP provider -> Cursor native MCP invocation
```

这是后续继续演进多 provider / 更完整 MCP 集成的基础。
