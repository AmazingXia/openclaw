import { existsSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir as resolveHomeDir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
} from "../agents/workspace.js";

export type CursorRequestContextRule =
  | {
      fullPath: string;
      content: string;
      type: { global: Record<string, never> };
    }
  | {
      fullPath: string;
      content: string;
      type: { fileGlobbed: { globs: string[] } };
    }
  | {
      fullPath: string;
      content: string;
      type: { agentFetched: { description: string } };
    }
  | {
      fullPath: string;
      content: string;
      type: { manuallyAttached: Record<string, never> };
    };

const OPENCLAW_BOOTSTRAP_FILENAMES = [
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
] as const;

const COMPAT_RULE_META_FILENAMES = ["CLAUDE.md", "CLAUDE.local.md", ".cursorrules"] as const;

const WALK_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  "out",
  ".idea",
  ".vscode",
]);

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function parseInlineArray(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }

  const inner = trimmed.slice(1, -1).trim();
  if (!inner) {
    return [];
  }

  return inner
    .split(",")
    .map((part) => stripWrappingQuotes(part.trim()))
    .filter(Boolean);
}

function parseFrontmatterDocument(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return null;
  }

  const parts = trimmed.split("---").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const frontmatterText = parts[0]?.trim() ?? "";
  const body = parts.slice(1).join("---").trim();
  const frontmatter: Record<string, unknown> = {};
  let readingGlobsArray = false;

  for (const rawLine of frontmatterText.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const listMatch = line.match(/^\s+-\s+(.*)$/);
    if (listMatch && readingGlobsArray) {
      const value = stripWrappingQuotes(listMatch[1]?.trim() ?? "");
      if (Array.isArray(frontmatter.globs) && value) {
        frontmatter.globs.push(value);
      }
      continue;
    }

    readingGlobsArray = false;
    const sep = line.indexOf(":");
    if (sep < 0) {
      continue;
    }

    const key = line.slice(0, sep).trim();
    const rawValue = line.slice(sep + 1).trim();

    if (key === "globs" && rawValue === "") {
      frontmatter.globs = [];
      readingGlobsArray = true;
      continue;
    }

    if (key === "globs") {
      const parsed = parseInlineArray(rawValue);
      if (parsed) {
        frontmatter.globs = parsed;
        continue;
      }
    }

    if (rawValue === "true") {
      frontmatter[key] = true;
    } else if (rawValue === "false") {
      frontmatter[key] = false;
    } else {
      frontmatter[key] = stripWrappingQuotes(rawValue);
    }
  }

  return { frontmatter, body };
}

function toRuleType(
  frontmatter: Record<string, unknown> = {},
  forceGlobal = false,
): CursorRequestContextRule["type"] {
  if (forceGlobal || frontmatter.alwaysApply === true) {
    return { global: {} };
  }

  const globs = Array.isArray(frontmatter.globs)
    ? frontmatter.globs.map((glob) => String(glob).trim()).filter(Boolean)
    : [];
  if (globs.length > 0) {
    return { fileGlobbed: { globs } };
  }

  const description =
    typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (description) {
    return { agentFetched: { description } };
  }

  return { manuallyAttached: {} };
}

function buildAncestorDirectories(startDir: string): string[] {
  const directories: string[] = [];
  let current = resolve(startDir);
  while (true) {
    directories.push(current);
    const parent = resolve(current, "..");
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return directories;
}

async function collectFiles(
  rootDir: string,
  predicate: (name: string, fullPath: string) => boolean,
): Promise<string[]> {
  const files: string[] = [];
  if (!existsSync(rootDir)) {
    return files;
  }

  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) {
      continue;
    }

    let entries: Awaited<ReturnType<typeof readdir>> = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (WALK_SKIP_DIRS.has(entry.name)) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }

      if (entry.isFile() && predicate(entry.name, fullPath)) {
        files.push(fullPath);
      }
    }
  }

  files.sort((left, right) => left.localeCompare(right));
  return files;
}

async function readTextFileIfExists(path: string): Promise<string | null> {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      return null;
    }
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

function pushRule(
  rules: CursorRequestContextRule[],
  seenPaths: Set<string>,
  rule: CursorRequestContextRule,
) {
  if (!rule.fullPath || !rule.content || seenPaths.has(rule.fullPath)) {
    return;
  }
  seenPaths.add(rule.fullPath);
  rules.push(rule);
}

export async function collectCursorRequestContextRules(
  workspaceRoot: string,
  options?: {
    homeDir?: string;
    includeHomeSkillRoots?: boolean;
    includeOpenClawBootstrapFiles?: boolean;
  },
): Promise<CursorRequestContextRule[]> {
  const rules: CursorRequestContextRule[] = [];
  const seenPaths = new Set<string>();
  const ancestorDirs = buildAncestorDirectories(workspaceRoot);
  const includeOpenClawBootstrapFiles = options?.includeOpenClawBootstrapFiles ?? true;
  for (const dir of ancestorDirs) {
    const rulesDir = join(dir, ".cursor", "rules");
    const mdcFiles = await collectFiles(rulesDir, (name) => name.endsWith(".mdc"));
    for (const filePath of mdcFiles) {
      const text = await readTextFileIfExists(filePath);
      if (!text) {
        continue;
      }
      const parsed = parseFrontmatterDocument(text);
      if (!parsed) {
        continue;
      }
      pushRule(rules, seenPaths, {
        fullPath: filePath,
        content: parsed.body,
        type: toRuleType(parsed.frontmatter),
      });
    }

    if (includeOpenClawBootstrapFiles) {
      for (const filename of OPENCLAW_BOOTSTRAP_FILENAMES) {
        const filePath = join(dir, filename);
        const text = await readTextFileIfExists(filePath);
        if (!text) {
          continue;
        }
        pushRule(rules, seenPaths, {
          fullPath: filePath,
          content: text,
          type: toRuleType({}, true),
        });
      }
    }

    for (const filename of COMPAT_RULE_META_FILENAMES) {
      const filePath = join(dir, filename);
      const text = await readTextFileIfExists(filePath);
      if (!text) {
        continue;
      }
      pushRule(rules, seenPaths, {
        fullPath: filePath,
        content: text,
        type: toRuleType({}, true),
      });
    }
  }

  const skillRoots = new Set<string>();
  for (const dir of ancestorDirs) {
    const base = basename(dir);
    if (base === ".openclaw") {
      // 支持 ~/.openclaw/skills 这种老路径
      skillRoots.add(join(dir, "skills"));
    } else {
      skillRoots.add(join(dir, ".openclaw", "skills"));
    }
  }

  const includeHomeSkillRoots = options?.includeHomeSkillRoots ?? true;
  if (includeHomeSkillRoots) {
    const homeDir = options?.homeDir ?? resolveHomeDir();
    skillRoots.add(join(homeDir, ".cursor", "skills"));
    skillRoots.add(join(homeDir, ".cursor", "skills-cursor"));
    skillRoots.add(join(homeDir, ".claude", "skills"));
    skillRoots.add(join(homeDir, ".codex", "skills"));
  }

  for (const skillsDir of skillRoots) {
    const skillFiles = await collectFiles(skillsDir, (name) => name === "SKILL.md");
    for (const filePath of skillFiles) {
      const text = await readTextFileIfExists(filePath);
      if (!text) {
        continue;
      }

      const parsed = parseFrontmatterDocument(text);
      const description =
        typeof parsed?.frontmatter.description === "string"
          ? parsed.frontmatter.description.trim()
          : "";
      if (!description) {
        continue;
      }

      pushRule(rules, seenPaths, {
        fullPath: filePath,
        content: text,
        type: { agentFetched: { description } },
      });
    }
  }
  return rules;
}
