# 桥接 OpenClaw 与 Cursor Agent

## 1. 核心问题

OpenClaw 和 Cursor Agent 各自有独立的工具体系，二者的协议在工具调用层面**不互通**：

| 维度     | Cursor Agent                                            | OpenClaw                                       |
| -------- | ------------------------------------------------------- | ---------------------------------------------- |
| 工具注册 | **不支持**自定义工具注册；内置 exec 工具集固定          | 动态工具列表，通过 `context.tools` 传入        |
| 工具调用 | 通过 `execServerMessage` 下发（read/write/shell/grep…） | LLM 输出 tool_call → 框架执行 `tool.execute()` |
| 工具结果 | 客户端执行后通过 `execClientMessage` 回传               | `AgentToolResult` 返回给 LLM                   |

**结论**：无法让 Cursor 像调用 `readArgs` 一样原生调用 `memory_search`、`message` 等 OpenClaw 工具。需要一个桥接层。

## 2. 桥接方案：Rules + Shell 拦截

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│  OpenClaw                                               │
│                                                         │
│  context.tools (AgentTool[])                            │
│    ├── memory_search                                    │
│    ├── memory_get                                       │
│    ├── message                                          │
│    ├── browser                                          │
│    ├── tts                                              │
│    └── ...                                              │
│         │                                               │
│         │ extractOpenClawTools()                         │
│         ▼                                               │
│  ┌──────────────────┐     ┌──────────────────────┐      │
│  │  发现层           │     │  执行层               │      │
│  │  buildToolRules() │     │  tryExecuteOpenClawTool() │ │
│  │                  │     │                      │      │
│  │  每个工具 →       │     │  shell 命令拦截：      │      │
│  │  CursorRule      │     │  "openclaw-tool xxx"  │      │
│  │  (agentFetched)  │     │    ↓                  │      │
│  │                  │     │  tool.execute(params)  │      │
│  └───────┬──────────┘     └──────────┬───────────┘      │
│          │                           │                   │
│          ▼                           ▼                   │
│  requestContextResult         shellResult / shellStream  │
│  (rules 数组)                 (stdout = 工具结果)         │
└─────────────────────────────────────────────────────────┘
                    │                  ▲
                    ▼                  │
          ┌─────────────────────────────┐
          │  Cursor Agent 服务端         │
          │                             │
          │  看到 rules → 知道有哪些工具   │
          │  想调用 → 发 shellStreamArgs  │
          │  command: "openclaw-tool     │
          │    memory_search '{...}'"    │
          └─────────────────────────────┘
```

### 2.2 发现层：工具 → Rules

Cursor 通过 `requestContextArgs` 请求上下文信息时，我们在 `requestContextResult` 中返回 rules。每个 OpenClaw 工具被转换为一条 `agentFetched` 类型的 rule：

```typescript
// CursorRule 结构（与 cursor-client.mjs 一致）
type CursorRule = {
  fullPath: string; // 虚拟路径，如 /workspace/.openclaw/tools/memory_search
  content: string; // 工具描述 + 参数文档 + 调用示例
  type: { global: {} } | { agentFetched: { description: string } };
};
```

**rule 内容示例**（以 `memory_search` 为例）：

````markdown
# OpenClaw Tool: memory_search

语义搜索 MEMORY.md + memory/\*.md，返回匹配片段...

## 参数

- query: string (必填) — 搜索关键词
- maxResults: number (可选)
- minScore: number (可选)

## 调用方式

在 shell 中运行以下命令来调用此工具：

```bash
openclaw-tool memory_search '<json_params>'
```
````

示例：

```bash
openclaw-tool memory_search '{"query":"<query>"}'
```

```

**关键点**：
- `type: { agentFetched: { description } }` — 与 Cursor Skills 格式一致，Cursor 会识别为可用能力
- `systemPrompt` 使用 `type: { global: {} }` — 全局生效，相当于 AGENTS.md

### 2.3 执行层：Shell 拦截

当 Cursor 决定调用某个 OpenClaw 工具时，它会通过 `shellStreamArgs` 或 `shellArgs` 发送 shell 命令。我们在处理器中拦截：

```

命令格式: openclaw-tool <tool_name> '<json_params>'

例如: openclaw-tool memory_search '{"query":"上次讨论了什么"}'

````

**处理流程**：

```typescript
async function tryExecuteOpenClawTool(command, tools) {
  // 1. 检测前缀
  if (!command.startsWith("openclaw-tool ")) return { handled: false };

  // 2. 解析工具名和参数
  const toolName = ...;
  const params = JSON.parse(rawArgs);

  // 3. 查找并执行
  const tool = tools.find(t => t.name === toolName);
  const result = await tool.execute(uuid(), params);

  // 4. 返回 JSON 结果
  return { handled: true, result: JSON.stringify(result) };
}
````

**在 shell handler 中的位置**：

```typescript
// shellStreamArgs handler
if (esmCase === "shellStreamArgs") {
  const shellCommand = asString(esmValue.command);
  setImmediate(async () => {
    // ← 先尝试工具桥接
    const toolBridge = await tryExecuteOpenClawTool(shellCommand, openclawTools);
    if (toolBridge.handled) {
      // 返回工具结果作为 stdout，exitCode=0
      send({ shellStream: { stdout: { data: toolBridge.result } } });
      send({ shellStream: { exit: { exitCode: 0 } } });
      return;
    }
    // ← 不是工具调用，走正常 shell 执行
    execShellOnce(workspace, esmValue);
  });
}
```

## 3. Rules 格式对照

### 修改前（旧格式，不匹配）

```typescript
rules: Array<{ content: string }>;
```

### 修改后（与 cursor-client.mjs 一致）

```typescript
rules: Array<{
  fullPath: string;
  content: string;
  type: { global: {} } | { agentFetched: { description: string } };
}>;
```

数据来源参考：`cursor-client/curor-agent-rule-data.json`

## 4. 工具覆盖范围

### Cursor 内置 exec 工具（直接处理，无需桥接）

| exec 消息                       | 功能       | 对应处理函数       |
| ------------------------------- | ---------- | ------------------ |
| `readArgs`                      | 读文件     | `readFile()`       |
| `writeArgs`                     | 写文件     | `execWriteFile()`  |
| `deleteArgs`                    | 删文件     | `execDeleteFile()` |
| `lsArgs`                        | 列目录     | `execLs()`         |
| `grepArgs`                      | 搜索       | `execGrep()`       |
| `fetchArgs`                     | HTTP 请求  | `execFetchUrl()`   |
| `shellArgs` / `shellStreamArgs` | 执行 shell | `execShellOnce()`  |
| `diagnosticsArgs`               | 诊断       | 返回空             |

### OpenClaw 独有工具（通过桥接）

| 工具名           | 来源                    | 说明                          |
| ---------------- | ----------------------- | ----------------------------- |
| `memory_search`  | `createRuntimeTools()`  | 语义搜索记忆文件              |
| `memory_get`     | `createRuntimeTools()`  | 读取记忆片段                  |
| `message`        | `createOpenClawTools()` | 发送消息/频道操作             |
| `browser`        | `createOpenClawTools()` | 浏览器控制                    |
| `tts`            | `createOpenClawTools()` | 文字转语音                    |
| `web_search`     | `createOpenClawTools()` | 网页搜索                      |
| `web_fetch`      | `createOpenClawTools()` | 抓取网页内容                  |
| `sessions_spawn` | `createOpenClawTools()` | 启动子代理                    |
| `session_status` | `createOpenClawTools()` | 会话状态                      |
| ...              | ...                     | 所有 `context.tools` 中的工具 |

## 5. 数据流完整路径

```
用户消息 → OpenClaw StreamFn
  │
  ├─ getPromptFromContext() → 提取 text + systemPrompt
  ├─ extractOpenClawTools() → 从 context.tools 提取工具引用
  │
  ├─ HTTP/2 连接 Cursor Agent (agent.api5.cursor.sh)
  │   └─ 发送 runRequest (userMessage + mode)
  │
  ├─ Cursor 请求上下文:
  │   └─ execServerMessage: requestContextArgs
  │       ↓
  │   buildRequestContext(workspace, systemPrompt, openclawTools)
  │       ├─ systemPrompt → CursorRule { type: global }
  │       └─ 每个工具 → CursorRule { type: agentFetched }
  │       ↓
  │   execClientMessage: requestContextResult { rules }
  │
  ├─ Cursor 调用内置工具:
  │   └─ execServerMessage: readArgs / writeArgs / grepArgs / ...
  │       ↓ 直接执行
  │   execClientMessage: readResult / writeResult / grepResult / ...
  │
  ├─ Cursor 调用 OpenClaw 工具:
  │   └─ execServerMessage: shellStreamArgs
  │       command: "openclaw-tool memory_search '{"query":"xxx"}'"
  │       ↓
  │   tryExecuteOpenClawTool()
  │       ↓ tool.execute(id, params)
  │   execClientMessage: shellStream { stdout: JSON结果, exit: 0 }
  │
  ├─ Cursor 输出文本:
  │   └─ interactionUpdate: textDelta / thinkingDelta
  │       ↓
  │   stream.push({ type: "delta", ... })
  │
  └─ Cursor 结束:
      └─ interactionUpdate: turnEnded
          ↓
      stream.push({ type: "done", ... })
```

## 6. 关键代码位置

| 文件                               | 函数/区域                  | 说明                      |
| ---------------------------------- | -------------------------- | ------------------------- |
| `cursor-agent-stream.ts:457-461`   | `CursorRule` 类型          | Cursor rules 结构定义     |
| `cursor-agent-stream.ts:465-469`   | `OpenClawToolRef` 接口     | 工具桥接接口              |
| `cursor-agent-stream.ts:474-477`   | `extractOpenClawTools()`   | 从 context.tools 提取工具 |
| `cursor-agent-stream.ts:495-521`   | `buildToolRules()`         | 工具 → CursorRule 转换    |
| `cursor-agent-stream.ts:540-583`   | `tryExecuteOpenClawTool()` | 拦截 shell 命令执行工具   |
| `cursor-agent-stream.ts:588-615`   | `buildRequestContext()`    | 组装完整 requestContext   |
| `cursor-agent-stream.ts:1027-1104` | `shellStreamArgs` handler  | Shell 流式拦截点          |
| `cursor-agent-stream.ts:1107-1150` | `shellArgs` handler        | Shell 同步拦截点          |

## 7. 已知限制与后续优化

1. **工具参数通过 JSON 字符串传递** — shell 命令中的 JSON 转义可能在复杂场景下出问题，目前已处理单引号/双引号包裹
2. **工具执行是同步阻塞式** — `tryExecuteOpenClawTool` 虽然是 async，但在 `setImmediate` 中执行，不会阻塞主流
3. **Cursor 不一定会调用** — Cursor 是否选择使用某个工具取决于其内部推理，注入 rules 只是让它「知道」有这些工具
4. **MCP 通道** — `EXEC_SERVER_MESSAGE_CASES` 中有 `mcpArgs`，未来可考虑通过 MCP 协议做更正式的工具桥接
5. **工具过滤** — 当前所有 `context.tools` 中的工具都会注入为 rules，可能需要白名单机制避免信息过载
