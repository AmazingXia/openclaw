# 本地开发配置说明 (openclaw.dev.json)

## 启动 Gateway（使用 Cursor 模型）

```bash
pnpm gateway:watch:cursor
```

## 浏览器访问 Control UI

- **地址：** http://127.0.0.1:18789/ （注意是 **18789**，不是 18791）
- **18791** 是 Browser 控制 API（需 HTTP Bearer token），不是给人用的网页。

### 带 Token 一键打开（避免 Unauthorized）

Token 在 `openclaw.dev.json` 的 `gateway.auth.token`。用下面格式打开，页面会自动保存 token 并去掉 URL 里的参数：

```
http://127.0.0.1:18789/?token=<你的 token>
```

查看当前 token：

```bash
node -e "console.log(require('./openclaw.dev.json').gateway.auth.token)"
```

或直接打开（把下面 TOKEN 换成上面命令输出的值）：

```
http://127.0.0.1:18789/?token=TOKEN
```

### 本地连接

从本机（127.0.0.1）连接时，设备配对会自动通过，无需 `openclaw devices approve`。
