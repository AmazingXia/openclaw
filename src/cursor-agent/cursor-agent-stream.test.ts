import type { Context } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { getPromptFromContext } from "./cursor-agent-stream.js";

function buildOpenClawUserText(text: string): string {
  return [
    "Sender (untrusted metadata):",
    "```json",
    '{ "label": "openclaw-control-ui", "id": "openclaw-control-ui" }',
    "```",
    `[Tue 2026-03-10 02:12 GMT+8] ${text}`,
  ].join("\n");
}

describe("cursor-agent stream prompt extraction", () => {
  it("keeps image blocks from the latest user message", () => {
    const context = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: buildOpenClawUserText("分析这个图片内容"),
            },
            {
              type: "image",
              data: "ZmFrZS1pbWFnZQ==",
              mimeType: "image/png",
            },
          ],
        },
      ],
    } as Context;

    const result = getPromptFromContext(context);

    expect(result.text).toBe("分析这个图片内容");
    expect(result.selectedImages).toHaveLength(1);
    expect(result.selectedImages[0]).toMatchObject({
      data: "ZmFrZS1pbWFnZQ==",
      mimeType: "image/png",
    });
    expect(result.selectedImages[0]?.uuid).toContain("openclaw-image-");
  });

  it("still returns images when the latest user message has no text", () => {
    const context = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              data: "aW1hZ2UtYnl0ZXM=",
              mimeType: "image/jpeg",
            },
          ],
        },
      ],
    } as Context;

    const result = getPromptFromContext(context);

    expect(result.text).toBe("");
    expect(result.selectedImages).toHaveLength(1);
    expect(result.selectedImages[0]).toMatchObject({
      data: "aW1hZ2UtYnl0ZXM=",
      mimeType: "image/jpeg",
    });
  });

  it("normalizes nested image payloads and strips data url prefixes", () => {
    const context = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: buildOpenClawUserText("帮我看看这张图"),
            },
            {
              type: "image_attachment",
              image: {
                data: "data:image/webp;base64,d2VicC1ieXRlcw==",
              },
            },
          ],
        },
      ],
    } as Context;

    const result = getPromptFromContext(context);

    expect(result.text).toBe("帮我看看这张图");
    expect(result.selectedImages).toHaveLength(1);
    expect(result.selectedImages[0]).toMatchObject({
      data: "d2VicC1ieXRlcw==",
      mimeType: "image/webp",
    });
  });
});
