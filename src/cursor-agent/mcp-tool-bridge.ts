import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";

const OPENCLAW_MCP_PROVIDER_IDENTIFIER = "openclaw";
const OPENCLAW_MCP_SERVER_IDENTIFIER = "openclaw.tools";
const OPENCLAW_MCP_STATE_DIR = ".openclaw/cursor-mcp";
const OPENCLAW_MCP_RESOURCE_URI_PREFIX = "openclaw-tool://definition/";
const OPENCLAW_MCP_RESOURCE_MIME = "application/json";

export interface OpenClawToolRef {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute?: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

type CursorMcpTool = {
  name: string;
  providerIdentifier: string;
  toolName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type CursorMcpInstruction = {
  serverName: string;
  serverIdentifier: string;
  instructions: string;
};

type CursorMcpDescriptor = {
  serverName: string;
  serverIdentifier: string;
  folderPath: string;
  serverUseInstructions?: string;
  tools: Array<{
    toolName: string;
    definitionPath: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
};

export type CursorMcpState = {
  tools: CursorMcpTool[];
  mcpInstructions: CursorMcpInstruction[];
  mcpFileSystemOptions: {
    enabled: boolean;
    workspaceProjectDir: string;
    mcpDescriptors: CursorMcpDescriptor[];
  };
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeSegment(value: string): string {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized.replace(/[^a-zA-Z0-9._-]/g, "_") : "unnamed";
}

function normalizeToolSchema(schema: unknown): Record<string, unknown> {
  if (isObject(schema)) {
    return schema;
  }
  return {
    type: "object",
    properties: {},
  };
}

function normalizeToolTextContent(item: unknown): string | null {
  if (!isObject(item)) {
    return null;
  }
  if (item.type === "text" && typeof item.text === "string") {
    return item.text;
  }
  if (typeof item.text === "string") {
    return item.text;
  }
  return null;
}

function normalizeToolImageContent(item: unknown): { data: string; mimeType: string } | null {
  if (!isObject(item) || item.type !== "image") {
    return null;
  }
  if (typeof item.data === "string") {
    return {
      data: item.data,
      mimeType: typeof item.mimeType === "string" ? item.mimeType : "image/png",
    };
  }
  return null;
}

function normalizeMcpResultContent(rawContent: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(rawContent)) {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const item of rawContent) {
    const textContent = normalizeToolTextContent(item);
    if (textContent !== null) {
      out.push({
        text: {
          text: textContent,
        },
      });
      continue;
    }

    const imageContent = normalizeToolImageContent(item);
    if (imageContent) {
      out.push({
        image: imageContent,
      });
      continue;
    }

    out.push({
      text: {
        text: JSON.stringify(item, null, 2),
      },
    });
  }
  return out;
}

function buildMcpTextSuccess(text: unknown, isError = false) {
  return {
    success: {
      content: [
        {
          text: {
            text: typeof text === "string" ? text : JSON.stringify(text, null, 2),
          },
        },
      ],
      isError,
    },
  };
}

function normalizeMcpValue(value: unknown): unknown {
  if (!isObject(value)) {
    return value;
  }
  if ("stringValue" in value) {
    return typeof value.stringValue === "string" ? value.stringValue : "";
  }
  if ("numberValue" in value) {
    return typeof value.numberValue === "number" ? value.numberValue : Number(value.numberValue);
  }
  if ("boolValue" in value) {
    return Boolean(value.boolValue);
  }
  if ("nullValue" in value) {
    return null;
  }
  if ("structValue" in value) {
    const structValue = isObject(value.structValue)
      ? ((value.structValue.fields as Record<string, unknown> | undefined) ?? value.structValue)
      : {};
    return normalizeMcpValue(structValue);
  }
  if ("listValue" in value) {
    const rawValues =
      isObject(value.listValue) && Array.isArray(value.listValue.values)
        ? value.listValue.values
        : [];
    return rawValues.map(normalizeMcpValue);
  }
  if (isObject(value.fields)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value.fields)) {
      out[key] = normalizeMcpValue(child);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = normalizeMcpValue(child);
  }
  return out;
}

function normalizeMcpArgs(args: unknown): Record<string, unknown> {
  if (!isObject(args)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = normalizeMcpValue(value);
  }
  return out;
}

function parseProviderAndToolName(value: string): { providerHint: string; toolName: string } {
  const text = String(value || "").trim();
  if (!text) {
    return { providerHint: "", toolName: "" };
  }
  for (const separator of ["/", ":", "."]) {
    const index = text.indexOf(separator);
    if (index > 0 && index < text.length - 1) {
      return {
        providerHint: text.slice(0, index).trim(),
        toolName: text.slice(index + 1).trim(),
      };
    }
  }
  return {
    providerHint: "",
    toolName: text,
  };
}

function dedupeTools(tools: OpenClawToolRef[]): OpenClawToolRef[] {
  const byName = new Map<string, OpenClawToolRef>();
  for (const tool of tools) {
    const name = typeof tool?.name === "string" ? tool.name.trim() : "";
    if (!name) {
      continue;
    }
    byName.set(name, {
      ...tool,
      name,
    });
  }
  return [...byName.values()];
}

function buildToolDefinitionText(tool: OpenClawToolRef): string {
  return JSON.stringify(
    {
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: normalizeToolSchema(tool.parameters),
    },
    null,
    2,
  );
}

function buildOpenClawDefinitionResourceUri(toolName: string): string {
  return `${OPENCLAW_MCP_RESOURCE_URI_PREFIX}${encodeURIComponent(toolName)}`;
}

function findToolByDefinitionUri(
  uri: string,
  tools: OpenClawToolRef[],
): OpenClawToolRef | undefined {
  if (!uri.startsWith(OPENCLAW_MCP_RESOURCE_URI_PREFIX)) {
    return undefined;
  }
  const encodedToolName = uri.slice(OPENCLAW_MCP_RESOURCE_URI_PREFIX.length);
  const toolName = decodeURIComponent(encodedToolName);
  return tools.find((tool) => tool.name === toolName);
}

export function extractOpenClawTools(contextTools: unknown[] | undefined): OpenClawToolRef[] {
  if (!Array.isArray(contextTools)) {
    return [];
  }
  return dedupeTools(
    contextTools.filter((tool): tool is OpenClawToolRef => {
      return isObject(tool) && typeof tool.name === "string";
    }),
  );
}

export async function buildOpenClawMcpState(
  workspaceRoot: string,
  tools: OpenClawToolRef[],
): Promise<CursorMcpState> {
  const workspace = resolve(workspaceRoot);
  const dedupedTools = dedupeTools(tools);
  const requestTools = dedupedTools.map((tool) => ({
    name: tool.name,
    providerIdentifier: OPENCLAW_MCP_PROVIDER_IDENTIFIER,
    toolName: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: normalizeToolSchema(tool.parameters),
  }));

  const serverFolder = resolve(
    join(workspace, OPENCLAW_MCP_STATE_DIR, sanitizeSegment(OPENCLAW_MCP_PROVIDER_IDENTIFIER)),
  );
  const serverUseInstructions =
    "Use the OpenClaw MCP server for native tool calls. Prefer providerIdentifier=openclaw and the tool's plain name.";

  const descriptor: CursorMcpDescriptor = {
    serverName: OPENCLAW_MCP_PROVIDER_IDENTIFIER,
    serverIdentifier: OPENCLAW_MCP_SERVER_IDENTIFIER,
    folderPath: serverFolder,
    serverUseInstructions,
    tools: requestTools.map((tool) => ({
      toolName: tool.toolName,
      definitionPath: resolve(
        join(serverFolder, "tools", `${sanitizeSegment(tool.toolName)}.json`),
      ),
      ...(tool.description ? { description: tool.description } : {}),
      ...(isObject(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {}),
    })),
  };

  for (const toolDescriptor of descriptor.tools) {
    try {
      await mkdir(dirname(toolDescriptor.definitionPath), { recursive: true });
      const matchingTool = dedupedTools.find((tool) => tool.name === toolDescriptor.toolName);
      await writeFile(
        toolDescriptor.definitionPath,
        buildToolDefinitionText(
          matchingTool ?? {
            name: toolDescriptor.toolName,
            description: toolDescriptor.description,
            parameters: toolDescriptor.inputSchema,
          },
        ),
        "utf-8",
      );
    } catch {}
  }

  return {
    tools: requestTools,
    mcpInstructions:
      requestTools.length > 0
        ? [
            {
              serverName: OPENCLAW_MCP_PROVIDER_IDENTIFIER,
              serverIdentifier: OPENCLAW_MCP_SERVER_IDENTIFIER,
              instructions: serverUseInstructions,
            },
          ]
        : [],
    mcpFileSystemOptions: {
      enabled: requestTools.length > 0,
      workspaceProjectDir: workspace,
      mcpDescriptors: requestTools.length > 0 ? [descriptor] : [],
    },
  };
}

export async function execOpenClawMcpTool(params: {
  args: Record<string, unknown>;
  tools: OpenClawToolRef[];
  signal?: AbortSignal;
}) {
  const normalizedArgs = normalizeMcpArgs(params.args.args);
  const providerIdentifier = (
    typeof params.args.providerIdentifier === "string" ? params.args.providerIdentifier : ""
  ).trim();
  const requestedName = (
    typeof params.args.toolName === "string"
      ? params.args.toolName
      : typeof params.args.name === "string"
        ? params.args.name
        : ""
  ).trim();
  const parsedName = parseProviderAndToolName(requestedName);
  const effectiveProvider = providerIdentifier || parsedName.providerHint;
  const toolName = parsedName.toolName || requestedName;
  const tools = dedupeTools(params.tools);

  if (
    effectiveProvider &&
    effectiveProvider !== OPENCLAW_MCP_PROVIDER_IDENTIFIER &&
    effectiveProvider !== OPENCLAW_MCP_SERVER_IDENTIFIER
  ) {
    return {
      toolNotFound: {
        name: toolName || requestedName,
        availableTools: tools.map((tool) => tool.name),
      },
    };
  }

  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool?.execute) {
    return {
      toolNotFound: {
        name: toolName || requestedName,
        availableTools: tools.map((candidate) => candidate.name),
      },
    };
  }

  try {
    const result = await tool.execute(randomUUID(), normalizedArgs, params.signal);
    const content = normalizeMcpResultContent((result as { content?: unknown })?.content);
    if (content.length === 0) {
      return buildMcpTextSuccess(result ?? {}, false);
    }
    return {
      success: {
        content,
        isError: false,
      },
    };
  } catch (error) {
    return {
      error: {
        error: String((error as Error)?.message || error),
      },
    };
  }
}

export async function listOpenClawMcpResources(params: {
  server?: string;
  tools: OpenClawToolRef[];
}) {
  const requestedServer = typeof params.server === "string" ? params.server.trim() : "";
  if (
    requestedServer &&
    requestedServer !== OPENCLAW_MCP_PROVIDER_IDENTIFIER &&
    requestedServer !== OPENCLAW_MCP_SERVER_IDENTIFIER
  ) {
    return {
      error: {
        error: `Server "${requestedServer}" not found`,
      },
    };
  }

  const tools = dedupeTools(params.tools);
  return {
    success: {
      resources: tools.map((tool) => ({
        uri: buildOpenClawDefinitionResourceUri(tool.name),
        server: OPENCLAW_MCP_PROVIDER_IDENTIFIER,
        name: `${tool.name}.json`,
        description: `OpenClaw MCP tool definition for ${tool.name}`,
        mimeType: OPENCLAW_MCP_RESOURCE_MIME,
        annotations: {
          kind: "tool-definition",
        },
      })),
    },
  };
}

export async function readOpenClawMcpResource(params: {
  uri?: string;
  server?: string;
  downloadPath?: string;
  tools: OpenClawToolRef[];
  workspaceRoot: string;
}) {
  const uri = String(params.uri ?? "").trim();
  const requestedServer = String(params.server ?? "").trim();
  if (
    requestedServer &&
    requestedServer !== OPENCLAW_MCP_PROVIDER_IDENTIFIER &&
    requestedServer !== OPENCLAW_MCP_SERVER_IDENTIFIER
  ) {
    return {
      error: {
        uri,
        error: `Server "${requestedServer}" not found`,
      },
    };
  }

  const tool = findToolByDefinitionUri(uri, dedupeTools(params.tools));
  if (!tool) {
    return {
      notFound: {
        uri,
      },
    };
  }

  const text = buildToolDefinitionText(tool);
  if (params.downloadPath) {
    const fullPath = resolve(params.workspaceRoot, String(params.downloadPath));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, text, "utf-8");
    return {
      success: {
        uri,
        name: `${tool.name}.json`,
        description: `OpenClaw MCP tool definition for ${tool.name}`,
        mimeType: OPENCLAW_MCP_RESOURCE_MIME,
        downloadPath: fullPath,
      },
    };
  }

  return {
    success: {
      uri,
      name: `${tool.name}.json`,
      description: `OpenClaw MCP tool definition for ${tool.name}`,
      mimeType: OPENCLAW_MCP_RESOURCE_MIME,
      text,
    },
  };
}
