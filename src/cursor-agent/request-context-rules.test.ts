import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectCursorRequestContextRules } from "./request-context-rules.js";

const tempDirs: string[] = [];

describe("collectCursorRequestContextRules", () => {
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("collects ancestor meta files and cursor rules", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-cursor-rules-"));
    tempDirs.push(root);

    const workspace = join(root, "project", "app");
    await mkdir(join(root, ".cursor", "rules"), { recursive: true });
    await mkdir(workspace, { recursive: true });

    const agentsPath = join(root, "AGENTS.md");
    const rulePath = join(root, ".cursor", "rules", "coding.mdc");

    await writeFile(agentsPath, "# root agents\n", "utf-8");
    await writeFile(
      rulePath,
      ["---", 'description: "Apply coding style"', "---", "Use project coding conventions."].join(
        "\n",
      ),
      "utf-8",
    );

    const rules = await collectCursorRequestContextRules(workspace, {
      includeHomeSkillRoots: false,
    });

    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fullPath: agentsPath,
          content: "# root agents\n",
          type: { global: {} },
        }),
        expect.objectContaining({
          fullPath: rulePath,
          content: "Use project coding conventions.",
          type: { agentFetched: { description: "Apply coding style" } },
        }),
      ]),
    );
  });

  it("collects skill files as agentFetched rules", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-cursor-skills-"));
    tempDirs.push(root);

    const workspace = join(root, "workspace");
    const skillDir = join(root, ".cursor", "skills", "demo-skill");
    await mkdir(skillDir, { recursive: true });
    await mkdir(workspace, { recursive: true });

    const skillPath = join(skillDir, "SKILL.md");
    await writeFile(
      skillPath,
      ["---", 'description: "Demo skill"', "---", "# Demo"].join("\n"),
      "utf-8",
    );

    const rules = await collectCursorRequestContextRules(workspace, {
      includeHomeSkillRoots: false,
    });

    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fullPath: skillPath,
          type: { agentFetched: { description: "Demo skill" } },
        }),
      ]),
    );
  });

  it("skips OpenClaw bootstrap files when requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-cursor-rules-no-bootstrap-"));
    tempDirs.push(root);

    const workspace = join(root, "project", "app");
    await mkdir(join(root, ".cursor", "rules"), { recursive: true });
    await mkdir(workspace, { recursive: true });

    const agentsPath = join(root, "AGENTS.md");
    const rulePath = join(root, ".cursor", "rules", "coding.mdc");

    await writeFile(agentsPath, "# root agents\n", "utf-8");
    await writeFile(
      rulePath,
      ["---", 'description: "Apply coding style"', "---", "Use project coding conventions."].join(
        "\n",
      ),
      "utf-8",
    );

    const rules = await collectCursorRequestContextRules(workspace, {
      includeHomeSkillRoots: false,
      includeOpenClawBootstrapFiles: false,
    });

    expect(rules).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fullPath: agentsPath,
        }),
      ]),
    );
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fullPath: rulePath,
          content: "Use project coding conventions.",
          type: { agentFetched: { description: "Apply coding style" } },
        }),
      ]),
    );
  });
});
