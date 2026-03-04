/**
 * Cursor Agent StreamFn Integration
 *
 * 将 Cursor IDE 的 Agent BiDi 协议接入 OpenClaw，作为可选的 LLM provider。
 * 协议与 cursor-client 一致：HTTP/2 连接 agent.api5.cursor.sh，Connect 信封编码。
 * 凭据直接写死在代码中，不使用配置。
 */

import { randomUUID } from "node:crypto";
import { connect as http2Connect } from "node:http2";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Message } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildAssistantMessageWithZeroUsage,
  buildStreamErrorAssistantMessage,
} from "./stream-message-shared.js";

const log = createSubsystemLogger("cursor-agent-stream");

const AGENT_API = "https://agent.api5.cursor.sh";
const CURSOR_CLIENT_VERSION = "2.4.36";

/** 内置凭据，与 cursor-client 一致，不使用配置 */
export const DEFAULT_CURSOR_CREDENTIALS: CursorAgentCredentials = {
  accessToken:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJnb29nbGUtb2F1dGgyfHVzZXJfMDFKWEo0REUzTkVURU5DMlRKTlIyWk1WMk4iLCJ0aW1lIjoiMTc3MjI4MjE0MSIsInJhbmRvbW5lc3MiOiI1ZjJlNzhkMS0wNDlhLTQ5NTMiLCJleHAiOjE3Nzc0NjYxNDEsImlzcyI6Imh0dHBzOi8vYXV0aGVudGljYXRpb24uY3Vyc29yLnNoIiwic2NvcGUiOiJvcGVuaWQgcHJvZmlsZSBlbWFpbCBvZmZsaW5lX2FjY2VzcyIsImF1ZCI6Imh0dHBzOi8vY3Vyc29yLmNvbSIsInR5cGUiOiJzZXNzaW9uIn0.NUlgmli5p0eitJVLVJiw2SiuRgsHcUh3jrcBzoNko9Y",
  machineId: "03e8fe0656b3e1c665051ad501113ccf1334674ce7a9148afa96d9e8aeda119c",
  macMachineId: "d191e79f7a73aedd1894528b019a5b6bfb88c8d30d22635aa1c043401ac10bd9",
};

const AGENT_MODE_AGENT = "AGENT_MODE_AGENT";
const AGENT_MODE_ASK = "AGENT_MODE_ASK";

export type CursorAgentCredentials = {
  accessToken: string;
  machineId?: string;
  macMachineId?: string;
};

export type CursorAgentStreamOptions = {
  signal?: AbortSignal;
  /** 使用 Ask 模式（仅对话，不执行工具） */
  askMode?: boolean;
};

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

/** 从 context.messages 取最后一条用户消息；若有 systemPrompt 则一并返回（用于内联到 text）。 */
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

/** 将系统提示与用户消息合并为一条发给 Cursor 的 text，用 <system> 与正文区分，避免使用 customSystemPrompt 触发的权限错误。 */
function buildTextWithInlineSystemPrompt(
  systemPrompt: string | undefined,
  userText: string,
): string {
  if (!systemPrompt) {
    return userText;
  }
  return `<system>\n${systemPrompt}\n</system>\n\n${userText}`;
}

/**
 * 创建使用 Cursor Agent BiDi 协议的 StreamFn。
 * 每次调用发送单轮用户消息，流式接收文本，结束时推一条 assistant message（无 tool call）。
 */
export function createCursorAgentStreamFn(
  creds: CursorAgentCredentials,
  options?: CursorAgentStreamOptions,
): StreamFn {
  const signal = options?.signal;
  const askMode = options?.askMode ?? true;

  // return (model, context, streamOptions) => {
  return (model, context) => {
    const stream = createAssistantMessageEventStream();
    const { text: userText, systemPrompt } = getPromptFromContext(context);
    // console.log('systemPrompt===>', systemPrompt)
    const text = buildTextWithInlineSystemPrompt(systemPrompt, userText);

    if (!userText) {
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

    const run = async () => {
      const requestId = randomUUID();
      const conversationId = randomUUID();
      const modeStr = askMode ? AGENT_MODE_ASK : AGENT_MODE_AGENT;
      console.log("modeStr===>", modeStr);

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
          // ...(systemPrompt ? { customSystemPrompt: systemPrompt } : {}),
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
            req.close();
            client.close();
          },
          { once: true },
        );
      }

      let fullText = "";
      let buffer = Buffer.alloc(0);
      let ended = false;

      const finish = (err?: Error) => {
        if (ended) {
          return;
        }
        ended = true;
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
          stream.push({
            type: "done",
            reason: "stop",
            message: buildAssistantMessageWithZeroUsage({
              model: { api: model.api, provider: model.provider, id: model.id },
              content: fullText ? [{ type: "text", text: fullText }] : [],
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
            } catch {
              // ignore
            }
            finish();
            return;
          }

          try {
            const msg = JSON.parse(payload) as {
              interactionUpdate?: {
                textDelta?: { text?: string };
                thinkingDelta?: { text?: string };
                heartbeat?: unknown;
                turnEnded?: unknown;
                stepCompleted?: unknown;
              };
              execServerMessage?: { requestContextArgs?: unknown };
            };

            if (msg.interactionUpdate?.textDelta?.text) {
              const t = msg.interactionUpdate.textDelta.text;
              fullText += t;
              continue;
            }
            if (msg.interactionUpdate?.thinkingDelta) {
              continue;
            }
            if (msg.interactionUpdate?.heartbeat) {
              continue;
            }
            if (msg.interactionUpdate?.turnEnded) {
              finish();
              return;
            }
            if (msg.interactionUpdate?.stepCompleted) {
              continue;
            }

            if (msg.execServerMessage?.requestContextArgs) {
              req.write(
                encodeEnvelope({
                  execClientMessage: {
                    requestContextResult: {
                      success: {
                        requestContext: {
                          env: {
                            osVersion: "darwin 25.0.0",
                            workspacePaths: ["/tmp/workspace"],
                            shell: "zsh",
                            sandboxEnabled: false,
                            timeZone: "Asia/Shanghai",
                            projectFolder: "/tmp/workspace",
                          },
                          webSearchEnabled: true,
                        },
                      },
                    },
                  },
                }),
              );
              continue;
            }
          } catch {
            // skip unparseable
          }
        }
      });

      req.on("end", () => finish());
      req.on("error", (err) => finish(err));
      setTimeout(() => {
        if (!ended) {
          finish(new Error("cursor-agent timeout"));
        }
      }, 120_000);
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
