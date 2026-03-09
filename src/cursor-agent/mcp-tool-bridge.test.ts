import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOpenClawMcpState,
  execOpenClawMcpTool,
  extractOpenClawTools,
  listOpenClawMcpResources,
  readOpenClawMcpResource,
} from "./mcp-tool-bridge.js";

const tempDirs: string[] = [];

async function createWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-cursor-mcp-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) =>
      rm(dir, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("cursor-agent mcp tool bridge", () => {
  it("builds MCP state and writes tool definitions", async () => {
    const workspace = await createWorkspace();
    const tools = extractOpenClawTools([
      {
        name: "browser",
        description: "OpenClaw browser tool",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
            },
          },
        },
      },
    ]);

    const state = await buildOpenClawMcpState(workspace, tools);

    expect(state.tools).toHaveLength(1);
    expect(state.tools[0]).toMatchObject({
      name: "browser",
      providerIdentifier: "openclaw",
      toolName: "browser",
    });
    expect(state.mcpFileSystemOptions.enabled).toBe(true);
    expect(state.mcpFileSystemOptions.mcpDescriptors).toHaveLength(1);

    const definitionPath = state.mcpFileSystemOptions.mcpDescriptors[0]?.tools[0]?.definitionPath;
    expect(definitionPath).toBeTruthy();
    const definition = JSON.parse(await readFile(String(definitionPath), "utf-8"));
    expect(definition).toMatchObject({
      name: "browser",
      description: "OpenClaw browser tool",
      inputSchema: {
        type: "object",
      },
    });
  });

  it("executes OpenClaw tools via mcpArgs and normalizes args", async () => {
    const result = await execOpenClawMcpTool({
      args: {
        providerIdentifier: "openclaw",
        toolName: "browser",
        args: {
          action: { stringValue: "snapshot" },
          depth: { numberValue: 2 },
        },
      },
      tools: [
        {
          name: "browser",
          execute: async (_toolCallId, params) => {
            expect(params).toEqual({
              action: "snapshot",
              depth: 2,
            });
            return {
              content: [
                {
                  type: "text",
                  text: "snapshot ok",
                },
              ],
              details: {},
            };
          },
        },
      ],
    });

    expect(result).toEqual({
      success: {
        content: [
          {
            text: {
              text: "snapshot ok",
            },
          },
        ],
        isError: false,
      },
    });
  });

  it("lists and reads synthetic MCP resources for tool definitions", async () => {
    const workspace = await createWorkspace();
    const tools = [
      {
        name: "message",
        description: "Send a message",
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
            },
          },
        },
      },
    ];

    const resources = await listOpenClawMcpResources({
      tools,
    });
    expect(resources).toMatchObject({
      success: {
        resources: [
          {
            server: "openclaw",
            name: "message.json",
          },
        ],
      },
    });

    const uri = (
      resources as {
        success: {
          resources: Array<{
            uri: string;
          }>;
        };
      }
    ).success.resources[0]?.uri;

    const readResult = await readOpenClawMcpResource({
      uri,
      tools,
      workspaceRoot: workspace,
    });

    expect(readResult).toMatchObject({
      success: {
        uri,
        name: "message.json",
        mimeType: "application/json",
      },
    });
    expect((readResult as { success: { text: string } }).success.text).toContain(
      '"name": "message"',
    );
  });
});
