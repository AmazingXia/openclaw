# OpenClaw Cursor Agent 图片透传适配变更记录（2026-03-10）

## 1. 问题背景

本次问题发生在 OpenClaw 的 Cursor Agent 桥接层：

1. OpenClaw 已经收到了用户消息中的图片块。
2. `getPromptFromContext(...)` 之前只提取文本。
3. 结果是传给 Cursor Agent 的请求只剩下文本，没有图片。

用户侧表现为：

1. 消息文本类似“分析这个图片内容”
2. `messages` 日志中能看到 `type: "image"`
3. Agent 却像纯文本模型一样回答，无法真正看图

本次排查使用的实际样本在：

1. `openclaw/.aaaaaaa/img/massege.json`

其中最后一条用户消息结构为：

1. `type: "text"`
2. `type: "image"`
3. 图片块中包含 `data` 与 `mimeType`

说明问题不是输入没图，而是桥接层丢图。

## 2. 根因

文件：

1. `openclaw/src/cursor-agent/cursor-agent-stream.ts`

旧逻辑中的 `getPromptFromContext(context)`：

1. 逆序找到最近一条 `role === "user"` 的消息
2. 从 `content` 数组中仅提取 `type === "text"` 的内容
3. 返回 `{ text, systemPrompt }`

缺失点很明确：

1. 没有提取图片
2. 没有返回图片
3. `createCursorAgentStreamFn(...)` 发请求时也没有构造 `selectedContext.selectedImages`

这导致整条多模态链路在 OpenClaw 侧断掉。

## 3. 参考协议与源码

本次适配参考了 Cursor 源码：

1. `Cursor.app/Contents/Resources/app/out/vs/workbench/api/node/extensionHostProcess.js`

关键结论：

### 3.1 `agent.v1.UserMessage`

包含字段：

1. `text`
2. `message_id`
3. `selected_context`
4. `mode`

### 3.2 `agent.v1.SelectedContext`

包含字段：

1. `selected_images`

### 3.3 `agent.v1.SelectedImage`

包含字段：

1. `data` 或 `blob_id`
2. `uuid`
3. `path`
4. `mime_type`

这说明 OpenClaw 要想把图片传给 Cursor Agent，正确做法不是把图片塞进文本，而是：

1. 提取图片
2. 归一化
3. 写入 `userMessage.selectedContext.selectedImages`

## 4. 本次改动

### 4.1 `getPromptFromContext(...)` 返回值扩展

现在返回：

```ts
{
  text: string;
  systemPrompt?: string;
  selectedImages: CursorSelectedImage[];
}
```

其中 `CursorSelectedImage` 结构为：

```ts
type CursorSelectedImage = {
  data: string;
  mimeType: string;
  uuid: string;
};
```

### 4.2 新增图片归一化逻辑

新增辅助函数：

1. `normalizeBase64ImageData(raw)`
2. `normalizeContextImagePart(part, index)`

它们负责：

1. 剥离 `data:image/...;base64,...` 前缀
2. 兼容普通 base64
3. 默认补齐 `mimeType`
4. 自动生成缺失的 `uuid`
5. 兼容多种图片块结构

当前兼容的形态包括：

1. 直接图片块

```json
{ "type": "image", "data": "...", "mimeType": "image/png" }
```

2. 嵌套图片对象

```json
{ "type": "image_attachment", "image": { "data": "...", "mimeType": "image/webp" } }
```

3. 仅有基础字段

```json
{ "data": "...", "mimeType": "image/jpeg" }
```

### 4.3 请求发送层补齐 `selectedImages`

在 `createCursorAgentStreamFn(...)` 中：

1. 先通过 `getPromptFromContext(context)` 同时取出 `text` / `systemPrompt` / `selectedImages`
2. 如果没有文本但有图片，不再提前 `done`
3. 构造 `runRequest` 时，把图片写入：

```ts
userMessage.selectedContext.selectedImages;
```

发送结构示意：

```json
{
  "userMessage": {
    "text": "分析这个图片内容",
    "messageId": "...",
    "mode": "AGENT_MODE_AGENT",
    "selectedContext": {
      "selectedImages": [
        {
          "data": "<base64>",
          "mimeType": "image/png",
          "uuid": "openclaw-image-..."
        }
      ]
    }
  }
}
```

## 5. 行为变化

### 5.1 修复前

即使用户消息里有图片：

1. OpenClaw 最终只会把文本发给 Cursor Agent
2. 没有文本时甚至可能提前结束流

### 5.2 修复后

现在行为变为：

1. 文本和图片会一起发送
2. 纯图片输入也能正常进入 Agent
3. 日志里会额外记录：
   - `imageCount`

## 6. 测试补充

新增测试文件：

1. `openclaw/src/cursor-agent/cursor-agent-stream.test.ts`

覆盖了三种场景：

1. 最新用户消息同时包含文本和图片
2. 最新用户消息只有图片没有文本
3. 嵌套图片对象 + `data:` URL 前缀

测试通过命令：

```bash
pnpm --dir openclaw exec vitest run src/cursor-agent/cursor-agent-stream.test.ts --config vitest.unit.config.ts
```

## 7. 与 `cursor-client` 的关系

这次修复实际上分两段：

1. `openclaw` 负责**从上下文中提取并透传图片**
2. `cursor-client` 负责**把图片正确挂到 Cursor Run 协议结构**

只有两边同时修，图片才能真正到达 Cursor Agent。

如果只修一边：

1. 只修 `openclaw`：图片可能还是在发送层丢失
2. 只修 `cursor-client`：OpenClaw 上游依然不会把图片交下来

## 8. 为什么不用“把图片转文本”

本次没有采用“把图片 base64 拼到 prompt 文本里”的方案，原因如下：

1. 这不符合 Cursor 的原生协议设计
2. 文本 token 会暴涨
3. 模型也未必把那段文本当真实图片处理
4. `selectedImages` 本来就是协议级多模态入口

因此正确做法就是走 `selectedContext.selectedImages`。

## 9. 本次结论

一句话总结：

> OpenClaw 的问题根因是 `getPromptFromContext(...)` 只提取文本、不提取图片；本次已在上下文提取层和 Run 请求发送层同时补齐 `selectedImages`，让 Cursor Agent 能真正收到图片。
