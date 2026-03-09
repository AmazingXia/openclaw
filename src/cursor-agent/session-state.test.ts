import type { Message } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  buildPromptWithHistory,
  createCursorSessionBridge,
  CURSOR_AGENT_SESSION_CUSTOM_TYPE,
  extractHistoryFromMessages,
} from "./session-state.js";

function buildOpenClawUserMessage(text: string): string {
  return [
    "Sender (untrusted metadata):",
    "```json",
    '{ "label": "tester", "id": "user-1" }',
    "```",
    "[Sun 2026-03-08 04:20 GMT+8] " + text,
  ].join("\n");
}

describe("cursor-agent session-state", () => {
  it("extracts recent history and strips OpenClaw user metadata", () => {
    const messages = [
      { role: "user", content: buildOpenClawUserMessage("之前的问题") },
      { role: "assistant", content: "之前的回答" },
      { role: "user", content: buildOpenClawUserMessage("当前问题") },
    ] as Message[];

    expect(extractHistoryFromMessages(messages, "当前问题")).toEqual([
      { role: "user", text: "之前的问题" },
      { role: "assistant", text: "之前的回答" },
    ]);
  });

  it("injects prior conversation only when conversationState is absent", () => {
    const prompt = buildPromptWithHistory(
      "现在继续",
      [
        { role: "user", text: "先前提问" },
        { role: "assistant", text: "先前回答" },
      ],
      false,
    );

    expect(prompt).toContain("<previous_conversation>");
    expect(prompt).toContain("[用户] 先前提问");
    expect(prompt).toContain("[助手] 先前回答");
    expect(prompt).toContain("<current_user_message>");
    expect(buildPromptWithHistory("现在继续", [], true)).toBe("现在继续");
  });

  it("loads and persists cursor state through SessionManager custom entries", () => {
    const appended: Array<{ customType: string; data: unknown }> = [];
    const store = {
      getBranch: () => [
        {
          type: "custom",
          customType: CURSOR_AGENT_SESSION_CUSTOM_TYPE,
          data: {
            conversationId: "conv-1",
            conversationState: { turns: [{ id: "turn-1" }] },
            notesSessionId: "notes-1",
            workspaceId: "workspace-1",
            updatedAt: "2026-03-10T00:00:00.000Z",
          },
        },
      ],
      appendCustomEntry: (customType: string, data?: unknown) => {
        appended.push({ customType, data });
        return `entry-${appended.length}`;
      },
      getSessionId: () => "session-1",
    };

    const bridge = createCursorSessionBridge(store);

    expect(bridge.getConversationId()).toBe("conv-1");
    expect(bridge.getConversationState()).toEqual({ turns: [{ id: "turn-1" }] });

    bridge.updateRequestContext({ notesSessionId: "notes-2", workspaceId: "workspace-2" });
    bridge.updateConversationCheckpoint({ turns: [{ id: "turn-2" }] });

    expect(appended).toHaveLength(2);
    expect(appended[0]?.customType).toBe(CURSOR_AGENT_SESSION_CUSTOM_TYPE);
    expect(appended[1]?.customType).toBe(CURSOR_AGENT_SESSION_CUSTOM_TYPE);
    expect(
      (appended[1]?.data as { conversationState: unknown } | undefined)?.conversationState,
    ).toEqual({
      turns: [{ id: "turn-2" }],
    });
    expect(
      bridge.buildHistoryRule(
        "/tmp/workspace",
        [
          { role: "assistant", content: "上一轮输出" },
          { role: "user", content: "当前问题" },
        ] as Message[],
        "当前问题",
      )?.fullPath,
    ).toContain(".cursor/session-history/notes-2.md");
  });
});
