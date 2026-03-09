import { randomUUID } from "crypto";
import { join } from "path";
import type { Message } from "@mariozechner/pi-ai";

export const CURSOR_AGENT_SESSION_CUSTOM_TYPE = "openclaw:cursor-agent-session-state";

const CURSOR_AGENT_SESSION_VERSION = 1;
const MAX_HISTORY_TURNS = 12;
const MAX_HISTORY_PROMPT_CHARS = 12_000;
const OPENCLAW_MSG_PREFIX_RE =
  /^Sender\s+\(untrusted metadata\):\s*```json\s*\{[\s\S]*?\}\s*```\s*\n*\s*\[[^\]]*\]\s*/;

export type CursorConversationState = Record<string, unknown>;

export type CursorSessionState = {
  version: number;
  conversationId: string;
  conversationState: CursorConversationState;
  notesSessionId: string;
  workspaceId: string;
  updatedAt: string;
};

export type CursorSessionHistoryEntry = {
  role: "user" | "assistant";
  text: string;
};

export type CursorSessionHistoryRule = {
  fullPath: string;
  content: string;
  description: string;
};

type CursorSessionEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
};

export type CursorSessionStore = {
  getBranch?: (fromId?: string) => CursorSessionEntry[];
  getEntries?: () => CursorSessionEntry[];
  appendCustomEntry?: (customType: string, data?: unknown) => string;
  getSessionId?: () => string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defaultCursorSessionState(): CursorSessionState {
  return {
    version: CURSOR_AGENT_SESSION_VERSION,
    conversationId: randomUUID(),
    conversationState: {},
    notesSessionId: "",
    workspaceId: "",
    updatedAt: new Date().toISOString(),
  };
}

function normalizeCursorSessionState(
  raw: unknown,
  defaults: CursorSessionState = defaultCursorSessionState(),
): CursorSessionState {
  return {
    version: CURSOR_AGENT_SESSION_VERSION,
    conversationId:
      isObject(raw) &&
      typeof raw.conversationId === "string" &&
      raw.conversationId.trim().length > 0
        ? raw.conversationId.trim()
        : defaults.conversationId,
    conversationState:
      isObject(raw) && isObject(raw.conversationState) ? raw.conversationState : {},
    notesSessionId:
      isObject(raw) && typeof raw.notesSessionId === "string" ? raw.notesSessionId.trim() : "",
    workspaceId: isObject(raw) && typeof raw.workspaceId === "string" ? raw.workspaceId.trim() : "",
    updatedAt:
      isObject(raw) && typeof raw.updatedAt === "string" ? raw.updatedAt : defaults.updatedAt,
  };
}

function buildStateSignature(state: CursorSessionState): string {
  return JSON.stringify({
    conversationId: state.conversationId,
    conversationState: state.conversationState,
    notesSessionId: state.notesSessionId,
    workspaceId: state.workspaceId,
  });
}

function getSessionEntries(store?: CursorSessionStore): CursorSessionEntry[] {
  if (!store) {
    return [];
  }
  if (typeof store.getBranch === "function") {
    try {
      return store.getBranch();
    } catch {}
  }
  if (typeof store.getEntries === "function") {
    try {
      return store.getEntries();
    } catch {}
  }
  return [];
}

export function stripOpenClawMetadata(raw: string): string {
  return raw.replace(OPENCLAW_MSG_PREFIX_RE, "");
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (!isObject(item)) {
        return "";
      }
      if (typeof item.text === "string") {
        return item.text;
      }
      if (typeof item.input_text === "string") {
        return item.input_text;
      }
      return "";
    })
    .join("");
}

function normalizeHistoryRole(role: unknown): "user" | "assistant" | null {
  if (role === "user" || role === "assistant") {
    return role;
  }
  return null;
}

function normalizeHistoryText(role: "user" | "assistant", content: unknown): string {
  const rawText = extractMessageText(content);
  const cleaned = role === "user" ? stripOpenClawMetadata(rawText) : rawText;
  return cleaned.trim();
}

export function extractHistoryFromMessages(
  messages: readonly Message[] | undefined,
  currentPrompt?: string,
): CursorSessionHistoryEntry[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  const history = messages
    .map((message) => {
      const role = normalizeHistoryRole((message as { role?: unknown }).role);
      if (!role) {
        return null;
      }
      const text = normalizeHistoryText(role, (message as { content?: unknown }).content);
      if (!text) {
        return null;
      }
      return { role, text } satisfies CursorSessionHistoryEntry;
    })
    .filter((entry): entry is CursorSessionHistoryEntry => entry !== null);

  const normalizedPrompt = typeof currentPrompt === "string" ? currentPrompt.trim() : "";
  if (
    normalizedPrompt &&
    history.length > 0 &&
    history[history.length - 1]?.role === "user" &&
    history[history.length - 1]?.text === normalizedPrompt
  ) {
    history.pop();
  }

  return history.slice(-MAX_HISTORY_TURNS);
}

export function buildPromptWithHistory(
  prompt: string,
  history: readonly CursorSessionHistoryEntry[],
  hasConversationState: boolean,
): string {
  const cleanPrompt = typeof prompt === "string" ? prompt.trim() : "";
  if (hasConversationState || !Array.isArray(history) || history.length === 0) {
    return cleanPrompt;
  }

  const lines: string[] = [];
  let usedChars = 0;
  for (const entry of history.slice(-MAX_HISTORY_TURNS).toReversed()) {
    const role = entry.role === "assistant" ? "助手" : "用户";
    const line = `[${role}] ${entry.text}`;
    usedChars += line.length + 1;
    if (usedChars > MAX_HISTORY_PROMPT_CHARS) {
      break;
    }
    lines.unshift(line);
  }

  if (lines.length === 0) {
    return cleanPrompt;
  }

  return [
    "<previous_conversation>",
    ...lines,
    "</previous_conversation>",
    "",
    "<current_user_message>",
    cleanPrompt,
    "</current_user_message>",
  ].join("\n");
}

export function buildSessionHistoryRule(params: {
  workspace: string;
  notesSessionId?: string;
  sessionId?: string;
  history: readonly CursorSessionHistoryEntry[];
}): CursorSessionHistoryRule | null {
  if (!Array.isArray(params.history) || params.history.length === 0) {
    return null;
  }

  const lines: string[] = [];
  let totalChars = 0;
  for (const entry of params.history.slice(-MAX_HISTORY_TURNS).toReversed()) {
    const line = `${entry.role}: ${entry.text}`;
    totalChars += line.length + 1;
    if (totalChars > MAX_HISTORY_PROMPT_CHARS) {
      break;
    }
    lines.unshift(line);
  }

  if (lines.length === 0) {
    return null;
  }

  const safeSessionId = (params.notesSessionId || params.sessionId || "local").replace(
    /[^a-zA-Z0-9_-]/g,
    "_",
  );

  return {
    fullPath: join(params.workspace, `.cursor/session-history/${safeSessionId}.md`),
    content: [
      "Session context summary generated by OpenClaw cursor-agent bridge.",
      "Use it as recent conversation context when needed.",
      "",
      ...lines,
    ].join("\n"),
    description: "Recent conversation history for this session.",
  };
}

export function loadCursorSessionState(store?: CursorSessionStore): CursorSessionState {
  const defaults = defaultCursorSessionState();
  const entries = getSessionEntries(store);

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== CURSOR_AGENT_SESSION_CUSTOM_TYPE) {
      continue;
    }
    return normalizeCursorSessionState(entry.data, defaults);
  }

  return defaults;
}

export type CursorSessionBridge = {
  getConversationId: () => string;
  getConversationState: () => CursorConversationState;
  getState: () => CursorSessionState;
  buildPrompt: (prompt: string, messages: readonly Message[] | undefined) => string;
  buildHistory: (
    messages: readonly Message[] | undefined,
    currentPrompt?: string,
  ) => CursorSessionHistoryEntry[];
  buildHistoryRule: (
    workspace: string,
    messages: readonly Message[] | undefined,
    currentPrompt?: string,
  ) => CursorSessionHistoryRule | null;
  updateRequestContext: (args: { notesSessionId?: string; workspaceId?: string }) => void;
  updateConversationCheckpoint: (conversationState: unknown) => void;
};

export function createCursorSessionBridge(store?: CursorSessionStore): CursorSessionBridge {
  let state = loadCursorSessionState(store);
  let lastPersistedSignature = buildStateSignature(state);

  const persist = () => {
    state = normalizeCursorSessionState({
      ...state,
      updatedAt: new Date().toISOString(),
    });

    const nextSignature = buildStateSignature(state);
    if (nextSignature === lastPersistedSignature) {
      return;
    }

    lastPersistedSignature = nextSignature;
    try {
      store?.appendCustomEntry?.(CURSOR_AGENT_SESSION_CUSTOM_TYPE, state);
    } catch {}
  };

  return {
    getConversationId: () => state.conversationId,
    getConversationState: () => state.conversationState,
    getState: () => state,
    buildPrompt: (prompt, messages) =>
      buildPromptWithHistory(
        prompt,
        extractHistoryFromMessages(messages, typeof prompt === "string" ? prompt.trim() : ""),
        Object.keys(state.conversationState).length > 0,
      ),
    buildHistory: (messages, currentPrompt) => extractHistoryFromMessages(messages, currentPrompt),
    buildHistoryRule: (workspace, messages, currentPrompt) =>
      buildSessionHistoryRule({
        workspace,
        notesSessionId: state.notesSessionId,
        sessionId: store?.getSessionId?.(),
        history: extractHistoryFromMessages(messages, currentPrompt),
      }),
    updateRequestContext: ({ notesSessionId, workspaceId }) => {
      const nextNotesSessionId =
        typeof notesSessionId === "string" ? notesSessionId.trim() : state.notesSessionId;
      const nextWorkspaceId =
        typeof workspaceId === "string" ? workspaceId.trim() : state.workspaceId;

      if (nextNotesSessionId === state.notesSessionId && nextWorkspaceId === state.workspaceId) {
        return;
      }

      state = {
        ...state,
        notesSessionId: nextNotesSessionId,
        workspaceId: nextWorkspaceId,
      };
      persist();
    },
    updateConversationCheckpoint: (conversationState) => {
      if (!isObject(conversationState) || Object.keys(conversationState).length === 0) {
        return;
      }

      state = {
        ...state,
        conversationState,
      };
      persist();
    },
  };
}
