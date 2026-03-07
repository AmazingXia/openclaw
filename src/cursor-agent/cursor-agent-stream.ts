/**
 * Cursor Agent StreamFn Integration
 *
 * 将 Cursor IDE 的 Agent BiDi 协议接入 OpenClaw，作为可选的 LLM provider。
 * 协议与 cursor-client 一致：HTTP/2 连接 agent.api5.cursor.sh，Connect 信封编码。
 *
 * 关键能力：
 *  - Agent 模式：Cursor 自主调用工具（read/write/shell/grep…），通过 execServerMessage 下发，客户端执行后回传
 *  - Ask 模式：纯对话，不执行工具
 *  - 注入 OpenClaw 的 systemPrompt、skills、workspace 信息到 requestContext
 *  - 分离 thinking 和 text 输出
 */

import { execSync, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import {
  // readFileSync, readdirSync,
  statSync,
  existsSync,
  appendFileSync,
} from "fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "fs/promises";
import { connect as http2Connect } from "http2";
import { homedir } from "os";
// import { basename, dirname, extname, join, resolve } from "path";
import { basename, dirname, join, resolve } from "path";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Message } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import {
  buildAssistantMessageWithZeroUsage,
  buildStreamErrorAssistantMessage,
  // buildUsageWithNoCost,
  // buildAssistantMessage as buildStreamAssistantMessage,
} from "../agents/stream-message-shared.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("cursor-agent-stream");

// ── 常量 ──────────────────────────────────────────────

const AGENT_API = "https://agent.api5.cursor.sh";
const CURSOR_CLIENT_VERSION = "2.4.36";
const CLIENT_HEARTBEAT_MS = 5000;
const HEARTBEAT_ONLY_MS = 3_000_000;
const GLOBAL_RUN_TIMEOUT_MS = 18_000_000;

const AGENT_MODE = {
  agent: "AGENT_MODE_AGENT",
  ask: "AGENT_MODE_ASK",
} as const;

// ── 日志与字符串安全转换 ───────────────────────────────

const LOG_FILE = join(process.cwd(), ".log/openclaw.log");
const CURSOR_LOG_FILE = join(process.cwd(), ".log/cursor.log");

/** 将 unknown 安全转为 string，避免 [object Object] */
function asString(v: unknown): string {
  if (v == null) {
    return "";
  }
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  return "";
}

function toLog(label: string, data: unknown) {
  if (typeof data === "object" && data) {
    const d = data as Record<string, unknown>;
    if (d?.interactionUpdate && typeof d.interactionUpdate === "object") {
      const iu = d.interactionUpdate as Record<string, unknown>;
      if (iu.tokenDelta) {
        return;
      }
    }
  }
  const ts = new Date().toISOString();
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  const logFile = label.indexOf("cursor") !== -1 ? CURSOR_LOG_FILE : LOG_FILE;
  try {
    appendFileSync(logFile, `[${ts}] ${label} ${payload}\n`);
  } catch {}
}

// ── 凭据 ──────────────────────────────────────────────

export type CursorAgentCredentials = {
  accessToken: string;
  machineId?: string;
  macMachineId?: string;
};

export const DEFAULT_CURSOR_CREDENTIALS: CursorAgentCredentials = {
  accessToken:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJnb29nbGUtb2F1dGgyfHVzZXJfMDFKWEo0REUzTkVURU5DMlRKTlIyWk1WMk4iLCJ0aW1lIjoiMTc3MjI4MjE0MSIsInJhbmRvbW5lc3MiOiI1ZjJlNzhkMS0wNDlhLTQ5NTMiLCJleHAiOjE3Nzc0NjYxNDEsImlzcyI6Imh0dHBzOi8vYXV0aGVudGljYXRpb24uY3Vyc29yLnNoIiwic2NvcGUiOiJvcGVuaWQgcHJvZmlsZSBlbWFpbCBvZmZsaW5lX2FjY2VzcyIsImF1ZCI6Imh0dHBzOi8vY3Vyc29yLmNvbSIsInR5cGUiOiJzZXNzaW9uIn0.NUlgmli5p0eitJVLVJiw2SiuRgsHcUh3jrcBzoNko9Y",
  machineId: "03e8fe0656b3e1c665051ad501113ccf1334674ce7a9148afa96d9e8aeda119c",
  macMachineId: "d191e79f7a73aedd1894528b019a5b6bfb88c8d30d22635aa1c043401ac10bd9",
};

export type CursorAgentStreamOptions = {
  signal?: AbortSignal;
  askMode?: boolean;
};

// ── Checksum ──────────────────────────────────────────

function computeChecksum(mid: string, mmid: string | undefined): string {
  const ts = Math.floor(Date.now() / 1e6);
  const b = new Uint8Array([
    (ts >> 40) & 0xff,
    (ts >> 32) & 0xff,
    (ts >> 24) & 0xff,
    (ts >> 16) & 0xff,
    (ts >> 8) & 0xff,
    ts & 0xff,
  ]);
  let s = 165;
  for (let i = 0; i < b.length; i++) {
    b[i] = ((b[i] ^ s) + (i % 256)) & 0xff;
    s = b[i];
  }
  return mmid
    ? `${Buffer.from(b).toString("base64")}${mid}/${mmid}`
    : `${Buffer.from(b).toString("base64")}${mid}`;
}

// ── HTTP 辅助 ──────────────────────────────────────────

function makeHeaders(creds: CursorAgentCredentials, requestId: string): Record<string, string> {
  return {
    authorization: `Bearer ${creds.accessToken}`,
    "x-cursor-checksum": computeChecksum(creds.machineId ?? "", creds.macMachineId),
    "x-cursor-client-version": CURSOR_CLIENT_VERSION,
    "x-cursor-client-type": "ide",
    "x-cursor-client-device-type": "desktop",
    "x-cursor-client-os": "darwin",
    "x-cursor-client-arch": process.arch === "arm64" ? "arm64" : "x64",
    "x-ghost-mode": "false",
    "x-request-id": requestId,
    "x-cursor-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
    "connect-protocol-version": "1",
  };
}

function encodeEnvelope(obj: unknown): Buffer {
  const buf = Buffer.from(JSON.stringify(obj), "utf-8");
  const env = Buffer.alloc(5 + buf.length);
  env.writeUInt32BE(buf.length, 1);
  buf.copy(env, 5);
  return env;
}

// ── 消息规范化 ──────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function normalizeOneof(
  raw: unknown,
  knownCases: string[],
  ignoreKeys: string[] = [],
): { case: string; value: Record<string, unknown> } | null {
  if (!isObject(raw)) {
    return null;
  }
  if (isObject(raw.message) && typeof raw.message.case === "string") {
    const m = raw.message;
    return { case: m.case as string, value: (m.value ?? {}) as Record<string, unknown> };
  }
  for (const key of knownCases) {
    if (raw[key] !== undefined) {
      return { case: key, value: (raw[key] ?? {}) as Record<string, unknown> };
    }
  }
  const ignored = new Set(ignoreKeys);
  for (const [key, value] of Object.entries(raw)) {
    if (!ignored.has(key)) {
      return { case: key, value: (value ?? {}) as Record<string, unknown> };
    }
  }
  return null;
}

const INTERACTION_UPDATE_CASES = [
  "textDelta",
  "thinkingDelta",
  "thinkingCompleted",
  "tokenDelta",
  "partialToolCall",
  "toolCallStarted",
  "toolCallDelta",
  "toolCallCompleted",
  "stepStarted",
  "stepCompleted",
  "summaryStarted",
  "summary",
  "summaryCompleted",
  "shellOutputDelta",
  "heartbeat",
  "turnEnded",
];

const EXEC_SERVER_MESSAGE_CASES = [
  "requestContextArgs",
  "readArgs",
  "lsArgs",
  "grepArgs",
  "diagnosticsArgs",
  "fetchArgs",
  "writeArgs",
  "deleteArgs",
  "shellArgs",
  "shellStreamArgs",
  "mcpArgs",
  "backgroundShellSpawnArgs",
  "writeShellStdinArgs",
  "computerUseArgs",
  "recordScreenArgs",
  "executeHookArgs",
  "listMcpResourcesExecArgs",
  "readMcpResourceExecArgs",
];

function normalizeInteractionUpdate(raw: unknown) {
  return normalizeOneof(raw, INTERACTION_UPDATE_CASES);
}

function normalizeExecServerMessage(
  raw: unknown,
): { id: number; execId: string; case: string; value: Record<string, unknown> } | null {
  if (!isObject(raw)) {
    return null;
  }
  const oneof = normalizeOneof(raw, EXEC_SERVER_MESSAGE_CASES, ["id", "execId", "spanContext"]);
  if (!oneof) {
    return null;
  }
  return {
    id: Number(raw.id ?? 0),
    execId: (raw.execId ?? "") as string,
    case: oneof.case,
    value: oneof.value,
  };
}

function normalizeRootMessage(raw: unknown): Record<string, unknown> {
  if (!isObject(raw)) {
    return {};
  }
  let msg = raw;
  if (isObject(msg.runResponse)) {
    msg = msg.runResponse;
  }
  if (isObject(msg.message) && typeof msg.message.case === "string") {
    const m = msg.message;
    if (msg[m.case as string] === undefined) {
      msg = { [m.case as string]: m.value };
    }
  }
  return msg;
}

// ── exec 工具执行（本地文件系统操作）──────────────────────

function resolvePath(workspaceRoot: string, p: string): string | null {
  if (!p) {
    return workspaceRoot;
  }
  const normalized = p.startsWith("/") ? p : join(workspaceRoot, p);
  return resolve(normalized);
}

async function execRead(workspace: string, path: string) {
  const full = resolvePath(workspace, path);
  if (!full || !existsSync(full)) {
    return { fileNotFound: {} };
  }
  try {
    const stat = statSync(full);
    if (!stat.isFile()) {
      return { error: { error: "Not a file" } };
    }
    const content = await readFile(full, "utf-8");
    return { success: { path: full, content, totalLines: content.split(/\n/).length } };
  } catch (e: unknown) {
    return { error: { error: String((e as Error).message) } };
  }
}

async function execLs(workspace: string, path: string) {
  const full = resolvePath(workspace, path || ".");
  if (!full || !existsSync(full)) {
    return { error: { error: "Path not found" } };
  }
  try {
    const stat = statSync(full);
    if (!stat.isDirectory()) {
      return { error: { error: "Not a directory" } };
    }
    const names = await readdir(full);
    const entries = names.map((name) => ({
      name,
      type: statSync(join(full, name)).isDirectory() ? "directory" : "file",
    }));
    return { success: { path: full, entries } };
  } catch (e: unknown) {
    return { error: { error: String((e as Error).message) } };
  }
}

async function execGrep(workspace: string, pattern: string, path: string) {
  const dir = resolvePath(workspace, path || ".");
  if (!dir || !existsSync(dir)) {
    return { error: { error: "Path not found" } };
  }
  try {
    const cmd = `grep -ri -n --include="*" -e ${JSON.stringify(pattern)} ${JSON.stringify(dir)} 2>/dev/null || true`;
    const out = execSync(cmd, { encoding: "utf-8", maxBuffer: 1024 * 1024 });
    const allMatches: Array<{ line: number; content: string }> = [];
    if (out.trim()) {
      for (const raw of out.trim().split("\n")) {
        const idx = raw.indexOf(":");
        const rest = idx > 0 ? raw.slice(idx + 1) : "";
        const m = rest.match(/^(\d+):(.*)$/);
        allMatches.push({ line: m ? parseInt(m[1], 10) : 0, content: m ? m[2].trim() : rest });
      }
    }
    return {
      success: {
        pattern,
        path: dir,
        outputMode: "content",
        workspaceResults: {
          [workspace]: {
            content: {
              matches: allMatches,
              totalLines: allMatches.length ? 10000 : 0,
              totalMatchedLines: allMatches.length,
            },
          },
        },
      },
    };
  } catch (e: unknown) {
    return { error: { error: String((e as Error).message) } };
  }
}

async function execWriteFile(workspace: string, value: Record<string, unknown>) {
  const p = asString(value.path);
  const content = asString(value.fileText ?? value.content);
  const full = resolvePath(workspace, p);
  if (!full) {
    return { error: { path: p, error: "Invalid path" } };
  }
  try {
    const dir = dirname(full);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(full, content, "utf-8");
    return { success: { path: full, linesWritten: content.split(/\n/).length } };
  } catch (e: unknown) {
    return { error: { path: p, error: String((e as Error).message) } };
  }
}

async function execDeleteFile(workspace: string, value: Record<string, unknown>) {
  const p = asString(value.path);
  const full = resolvePath(workspace, p);
  if (!full || !existsSync(full)) {
    return { error: { path: p, error: "File not found" } };
  }
  try {
    await unlink(full);
    return { success: { path: full } };
  } catch (e: unknown) {
    return { error: { path: p, error: String((e as Error).message) } };
  }
}

async function execFetchUrl(url: string) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "OpenClaw/1.0" } });
    const text = await res.text();
    return { success: { statusCode: res.status, body: text } };
  } catch (e: unknown) {
    return { error: { error: String((e as Error).message) } };
  }
}

function execShellOnce(workspace: string, args: Record<string, unknown>) {
  const command = asString(args.command);
  const cwd = resolvePath(workspace, asString(args.workingDirectory) || ".") ?? workspace;
  const timeoutMs = Number(args.timeout ?? 30000);
  try {
    const result = spawnSync("bash", ["-c", command], {
      cwd,
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env },
    });
    return {
      success: {
        command,
        workingDirectory: cwd,
        exitCode: result.status ?? 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      },
    };
  } catch (e: unknown) {
    return {
      spawnError: {
        command,
        workingDirectory: cwd,
        error: String((e as Error).message),
      },
    };
  }
}

// ── 从 context 提取 prompt ──────────────────────────────

function getPromptFromContext(context: Context): { text: string; systemPrompt?: string } {
  const messages = context.messages ?? [];
  let lastUserText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Message & { role: string; content: unknown };
    if (m.role === "user") {
      lastUserText = typeof m.content === "string" ? m.content : "";
      if (Array.isArray(m.content)) {
        lastUserText = (m.content as Array<{ type?: string; text?: string }>)
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => (p as { text: string }).text)
          .join("");
      }
      break;
    }
  }
  const systemPrompt =
    typeof context.systemPrompt === "string" && context.systemPrompt.trim().length > 0
      ? context.systemPrompt.trim()
      : undefined;
  return { text: lastUserText.trim(), systemPrompt };
}

// ── 构建 requestContext（注入 OpenClaw 信息）──────────────

function buildRequestContext(workspace: string, systemPrompt?: string, tools?: unknown[]) {
  const rules: Array<{ content: string }> = [];

  if (systemPrompt) {
    rules.push({ content: systemPrompt });
  }

  if (tools && Array.isArray(tools) && tools.length > 0) {
    const toolDescriptions = (tools as Array<{ name?: string; description?: string }>)
      .filter((t) => t.name)
      .map((t) => `- ${t.name}: ${t.description ?? "(no description)"}`)
      .join("\n");
    if (toolDescriptions) {
      rules.push({
        content: `## OpenClaw Available Tools\nThe following tools are available in the OpenClaw environment. When you need to perform these actions, execute them directly using the corresponding exec tools (read files, write files, run shell commands, etc.):\n${toolDescriptions}`,
      });
    }
  }

  return {
    env: {
      osVersion: `${process.platform} ${process.version}`,
      workspacePaths: [workspace],
      shell: basename(process.env.SHELL || "zsh"),
      sandboxEnabled: false,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      projectFolder: workspace,
    },
    webSearchEnabled: true,
    rules,
  };
}

// ── 核心 StreamFn ──────────────────────────────────────

export function createCursorAgentStreamFn(
  creds: CursorAgentCredentials,
  options?: CursorAgentStreamOptions,
): StreamFn {
  const signal = options?.signal;
  const askMode = options?.askMode ?? false;

  return (model, context, _streamOptions) => {
    const stream = createAssistantMessageEventStream();

    const { text, systemPrompt } = getPromptFromContext(context);
    const contextTools = (context as unknown as Record<string, unknown>).tools as
      | unknown[]
      | undefined;

    toLog("cursor-start", {
      text: text.slice(0, 200),
      hasSystemPrompt: !!systemPrompt,
      toolCount: contextTools?.length ?? 0,
    });

    if (!text) {
      stream.push({
        type: "done",
        reason: "stop",
        message: buildAssistantMessageWithZeroUsage({
          model: { api: model.api, provider: model.provider, id: model.id },
          content: [],
          stopReason: "stop",
        }),
      });
      stream.end();
      return stream;
    }

    const ctxAny = context as unknown as Record<string, unknown>;
    const workspace = resolve(
      typeof ctxAny.workspaceRoot === "string"
        ? ctxAny.workspaceRoot
        : process.env.OPENCLAW_WORKSPACE || join(homedir(), ".openclaw/workspace"),
    );

    const run = async () => {
      const requestId = randomUUID();
      const conversationId = randomUUID();
      const modeStr = askMode ? AGENT_MODE.ask : AGENT_MODE.agent;

      const runRequest = {
        runRequest: {
          conversationState: {},
          action: {
            userMessageAction: {
              userMessage: {
                text,
                messageId: randomUUID(),
                mode: modeStr,
              },
            },
          },
          modelDetails: { modelId: model.id === "default" ? "default" : model.id },
          conversationId,
        },
      };

      const client = http2Connect(AGENT_API);
      const req = client.request({
        ":method": "POST",
        ":path": "/agent.v1.AgentService/Run",
        "content-type": "application/connect+json",
        ...makeHeaders(creds, requestId),
      });

      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            try {
              req.close();
            } catch {}
            try {
              client.close();
            } catch {}
          },
          { once: true },
        );
      }

      let fullText = "";
      let thinkingText = "";
      let buffer = Buffer.alloc(0);
      let ended = false;
      let lastSubstantiveAt = 0;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

      const send = (obj: unknown) => {
        try {
          req.write(encodeEnvelope(obj));
        } catch (e) {
          toLog("cursor-send-error", String(e));
        }
      };

      const finish = (err?: Error) => {
        if (ended) {
          return;
        }
        ended = true;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        try {
          req.close();
        } catch {}
        try {
          client.close();
        } catch {}

        if (err) {
          stream.push({
            type: "error",
            reason: "error",
            error: buildStreamErrorAssistantMessage({
              model: { api: model.api, provider: model.provider, id: model.id },
              errorMessage: err.message,
            }),
          });
        } else {
          const contentParts: Array<{ type: "text"; text: string }> = [];
          if (thinkingText) {
            contentParts.push({ type: "text", text: `<think>\n${thinkingText}\n</think>` });
          }
          if (fullText) {
            contentParts.push({ type: "text", text: fullText });
          }
          stream.push({
            type: "done",
            reason: "stop",
            message: buildAssistantMessageWithZeroUsage({
              model: { api: model.api, provider: model.provider, id: model.id },
              content: contentParts.length > 0 ? contentParts : [],
              stopReason: "stop",
            }),
          });
        }
        stream.end();
      };

      client.on("error", (e) => {
        log.warn("cursor-agent http2 client error", { err: e.message });
        finish(e);
      });

      req.write(encodeEnvelope(runRequest));

      heartbeatTimer = setInterval(() => {
        if (!ended) {
          send({ clientHeartbeat: {} });
        }
      }, CLIENT_HEARTBEAT_MS);

      req.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 5) {
          const flags = buffer[0];
          const len = buffer.readUInt32BE(1);
          if (buffer.length < 5 + len) {
            break;
          }
          const payload = buffer.subarray(5, 5 + len).toString("utf-8");
          buffer = buffer.subarray(5 + len);

          if (flags & 0x02) {
            try {
              const t = JSON.parse(payload) as { error?: { code?: string; message?: string } };
              if (t.error) {
                finish(new Error(`[${t.error.code ?? ""}] ${t.error.message ?? ""}`));
                return;
              }
            } catch {}
            finish();
            return;
          }

          try {
            const rawMsg = JSON.parse(payload);
            toLog("cursor-msg===>", rawMsg);
            const msg = normalizeRootMessage(rawMsg);

            // ── interactionUpdate ──
            const iu = normalizeInteractionUpdate(msg.interactionUpdate);
            if (iu) {
              switch (iu.case) {
                case "textDelta": {
                  const t = iu.value?.text;
                  if (typeof t === "string") {
                    lastSubstantiveAt = Date.now();
                    fullText += t;
                  }
                  break;
                }
                case "thinkingDelta": {
                  const t = iu.value?.text;
                  if (typeof t === "string") {
                    lastSubstantiveAt = Date.now();
                    thinkingText += t;
                  }
                  break;
                }
                case "thinkingCompleted":
                  lastSubstantiveAt = Date.now();
                  toLog("cursor-thinking-completed", { durationMs: iu.value?.thinkingDurationMs });
                  break;
                case "partialToolCall":
                  lastSubstantiveAt = Date.now();
                  break;
                case "toolCallStarted":
                  lastSubstantiveAt = Date.now();
                  toLog("cursor-tool-started", {
                    callId: iu.value?.callId,
                    toolCall: iu.value?.toolCall,
                  });
                  break;
                case "toolCallDelta":
                  lastSubstantiveAt = Date.now();
                  break;
                case "toolCallCompleted":
                  lastSubstantiveAt = Date.now();
                  toLog("cursor-tool-completed", { callId: iu.value?.callId });
                  break;
                case "stepStarted":
                case "stepCompleted":
                case "summaryStarted":
                case "summary":
                case "summaryCompleted":
                  lastSubstantiveAt = Date.now();
                  break;
                case "shellOutputDelta":
                  lastSubstantiveAt = Date.now();
                  break;
                case "heartbeat":
                  if (lastSubstantiveAt > 0 && Date.now() - lastSubstantiveAt > HEARTBEAT_ONLY_MS) {
                    toLog("cursor-finish-by-heartbeat-only-timeout", {});
                    finish();
                    return;
                  }
                  break;
                case "turnEnded":
                  toLog("cursor-turn-ended", iu.value);
                  finish();
                  return;
                default:
                  break;
              }
              continue;
            }

            // ── kvServerMessage（忽略）──
            if (msg.kvServerMessage) {
              continue;
            }

            // ── execServerMessage ──
            const esm = normalizeExecServerMessage(msg.execServerMessage);
            if (esm) {
              toLog("cursor-esm===>", esm);
              const { id, case: esmCase, value: esmValue } = esm;
              const base = { id, ...(esm.execId ? { execId: esm.execId } : {}) };
              const closeExecStream = () => {
                send({ execClientControlMessage: { streamClose: { id } } });
              };

              if (esmCase === "requestContextArgs") {
                const requestContext = buildRequestContext(workspace, systemPrompt, contextTools);
                toLog("cursor-requestContext-built", {
                  workspace,
                  rulesCount: requestContext.rules.length,
                });
                send({
                  execClientMessage: {
                    ...base,
                    requestContextResult: {
                      success: { requestContext },
                    },
                  },
                });
                closeExecStream();
                continue;
              }

              if (esmCase === "readArgs") {
                const path = asString(esmValue.path);
                execRead(workspace, path)
                  .then((result) => {
                    send({ execClientMessage: { ...base, readResult: result } });
                    closeExecStream();
                  })
                  .catch((e) => {
                    send({
                      execClientMessage: { ...base, readResult: { error: { error: String(e) } } },
                    });
                    closeExecStream();
                  });
                continue;
              }

              if (esmCase === "lsArgs") {
                const path = asString(esmValue.path);
                execLs(workspace, path)
                  .then((result) => {
                    send({ execClientMessage: { ...base, lsResult: result } });
                    closeExecStream();
                  })
                  .catch((e) => {
                    send({
                      execClientMessage: { ...base, lsResult: { error: { error: String(e) } } },
                    });
                    closeExecStream();
                  });
                continue;
              }

              if (esmCase === "grepArgs") {
                const pattern = asString(esmValue.pattern ?? esmValue.regex);
                const path = asString(esmValue.path);
                execGrep(workspace, pattern, path)
                  .then((result) => {
                    send({ execClientMessage: { ...base, grepResult: result } });
                    closeExecStream();
                  })
                  .catch((e) => {
                    send({
                      execClientMessage: { ...base, grepResult: { error: { error: String(e) } } },
                    });
                    closeExecStream();
                  });
                continue;
              }

              if (esmCase === "diagnosticsArgs") {
                send({
                  execClientMessage: {
                    ...base,
                    diagnosticsResult: { success: { diagnostics: [] } },
                  },
                });
                closeExecStream();
                continue;
              }

              if (esmCase === "fetchArgs") {
                const url = asString(esmValue.url);
                execFetchUrl(url)
                  .then((result) => {
                    send({ execClientMessage: { ...base, fetchResult: result } });
                    closeExecStream();
                  })
                  .catch((e) => {
                    send({
                      execClientMessage: { ...base, fetchResult: { error: { error: String(e) } } },
                    });
                    closeExecStream();
                  });
                continue;
              }

              if (esmCase === "writeArgs") {
                execWriteFile(workspace, esmValue)
                  .then((result) => {
                    send({ execClientMessage: { ...base, writeResult: result } });
                    closeExecStream();
                  })
                  .catch((e) => {
                    send({
                      execClientMessage: {
                        ...base,
                        writeResult: { error: { path: asString(esmValue.path), error: String(e) } },
                      },
                    });
                    closeExecStream();
                  });
                continue;
              }

              if (esmCase === "deleteArgs") {
                execDeleteFile(workspace, esmValue)
                  .then((result) => {
                    send({ execClientMessage: { ...base, deleteResult: result } });
                    closeExecStream();
                  })
                  .catch((e) => {
                    send({
                      execClientMessage: {
                        ...base,
                        deleteResult: {
                          error: { path: asString(esmValue.path), error: String(e) },
                        },
                      },
                    });
                    closeExecStream();
                  });
                continue;
              }

              if (esmCase === "shellStreamArgs") {
                const toolCallId = asString(esmValue.toolCallId);
                const shellBase = { ...base, ...(toolCallId ? { toolCallId } : {}) };
                setImmediate(() => {
                  try {
                    send({ execClientMessage: { ...shellBase, shellStream: { start: {} } } });
                    const result = execShellOnce(workspace, esmValue) as unknown as Record<
                      string,
                      unknown
                    >;
                    const success = result.success as Record<string, unknown> | undefined;
                    const spawnError = result.spawnError as Record<string, unknown> | undefined;
                    const out = asString(success?.stdout ?? spawnError?.error);
                    const err = asString(success?.stderr);
                    const cwd = asString(success?.workingDirectory) || workspace;
                    if (out) {
                      send({
                        execClientMessage: { ...shellBase, shellStream: { stdout: { data: out } } },
                      });
                    }
                    if (err) {
                      send({
                        execClientMessage: { ...shellBase, shellStream: { stderr: { data: err } } },
                      });
                    }
                    if (success?.exitCode !== undefined) {
                      send({
                        execClientMessage: {
                          ...shellBase,
                          shellStream: {
                            exit: { exitCode: success.exitCode, workingDirectory: cwd },
                          },
                        },
                      });
                    } else if (spawnError) {
                      send({
                        execClientMessage: {
                          ...shellBase,
                          shellStream: { rejected: { reason: String(spawnError.error) } },
                        },
                      });
                    }
                    closeExecStream();
                  } catch (e) {
                    send({
                      execClientMessage: {
                        ...shellBase,
                        shellStream: { rejected: { reason: String(e) } },
                      },
                    });
                    closeExecStream();
                  }
                });
                continue;
              }

              if (esmCase === "shellArgs") {
                const result = execShellOnce(workspace, esmValue);
                send({
                  execClientMessage: { ...base, shellResult: { ...result, isBackground: false } },
                });
                closeExecStream();
                continue;
              }

              toLog("cursor-unhandled-esm", { esmCase, esmValue });
              closeExecStream();
              continue;
            }
          } catch (e) {
            toLog("cursor-parse-error", String(e));
          }
        }
      });

      req.on("end", () => finish());
      req.on("error", (err) => finish(err));
      setTimeout(() => {
        if (!ended) {
          toLog("cursor-global-timeout", {});
          finish(new Error("cursor-agent global timeout"));
        }
      }, GLOBAL_RUN_TIMEOUT_MS);
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
