import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildNestedWorkspaceInstructionBlock,
  buildWorkspaceContext,
  buildWorkspaceContextDelta,
  buildWorkspaceInstructionBaseline,
  collectRelatedWorkspacePaths,
  formatAvailableSkills,
} from "./workspace-context";
import type { UIMessage } from "ai";

const tempDir = () => mkdtemp(path.join(tmpdir(), "lc-ws-"));

describe("buildWorkspaceContext", () => {
  test("includes cwd, listing, and root instructions; degrades for non-git dirs", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "AGENTS.md"), "Always run bun test.");
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "index.ts"), "export {};");

    const block = await buildWorkspaceContext({ cwd: dir });

    expect(block).toContain("<environment>");
    expect(block).toContain(`Working directory: ${dir}`);
    expect(block).toContain("Not a git repository.");
    expect(block).toContain("AGENTS.md");
    expect(block).toContain("Always run bun test.");
    expect(block).toContain("src/");
    expect(block.trimEnd().endsWith("</environment>")).toBe(true);
  });

  test("truncates oversized instructions and stays bounded", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "AGENTS.md"), "x".repeat(50_000));

    const block = await buildWorkspaceContext({ cwd: dir });

    expect(block).toContain("truncated");
    expect(block.length).toBeLessThanOrEqual(18_200);
  });

  test("never throws for a missing directory", async () => {
    const block = await buildWorkspaceContext({
      cwd: path.join(tmpdir(), "lc-does-not-exist-xyz"),
    });
    expect(block).toContain("<environment>");
  });

  test("surfaces discovered skills in the environment block", async () => {
    const dir = await tempDir();
    const skillDir = path.join(dir, ".lightcode", "skills", "demo-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      ["---", "name: demo-skill", "description: A demo", "---", "Body"].join(
        "\n",
      ),
    );

    const block = await buildWorkspaceContext({ cwd: dir });

    expect(block).toContain("Available skills");
    expect(block).toContain("demo-skill: A demo");
  });
});

describe("buildWorkspaceContextDelta", () => {
  test("replays instructions and keeps cwd/git while dropping the listing", async () => {
    const dir = await tempDir();
    await writeFile(
      path.join(dir, "AGENTS.md"),
      `Always run bun test.\n${"Project conventions. ".repeat(50)}`,
    );
    await mkdir(path.join(dir, "src"));

    const [full, delta] = await Promise.all([
      buildWorkspaceContext({ cwd: dir }),
      buildWorkspaceContextDelta({ cwd: dir }),
    ]);

    expect(delta).toContain("<environment>");
    expect(delta).toContain(`Working directory: ${dir}`);
    expect(delta).toContain("Git:");
    expect(delta).not.toContain("Top-level entries:");
    expect(delta).toContain("Always run bun test.");
    expect(delta).toContain('source="AGENTS.md"');
    expect(full).toContain("Top-level entries:");
    expect(delta.trimEnd().endsWith("</environment>")).toBe(true);
  });

  test("never throws for a missing directory", async () => {
    const block = await buildWorkspaceContextDelta({
      cwd: path.join(tmpdir(), "lc-does-not-exist-xyz"),
    });
    expect(block).toContain("<environment>");
  });
});

describe("buildWorkspaceInstructionBaseline", () => {
  test("prefers AGENTS.md, ignores README, and is source hashed", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "AGENTS.md"), "Use Bun.");
    await writeFile(path.join(dir, "CLAUDE.md"), "Use npm.");
    await writeFile(path.join(dir, "README.md"), "Privileged? no.");

    const first = await buildWorkspaceInstructionBaseline({ cwd: dir });
    const second = await buildWorkspaceInstructionBaseline({ cwd: dir });

    expect(first.source).toBe("AGENTS.md");
    expect(first.content).toBe("Use Bun.");
    expect(first.block).not.toContain("Use npm.");
    expect(first.block).not.toContain("Privileged? no.");
    expect(first.sha256).toBe(second.sha256);
    expect(first.block).toBe(second.block);
  });

  test("falls back to CLAUDE.md when AGENTS.md is absent", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "CLAUDE.md"), "Use pnpm.");

    const baseline = await buildWorkspaceInstructionBaseline({ cwd: dir });

    expect(baseline.source).toBe("CLAUDE.md");
    expect(baseline.block).toContain("Use pnpm.");
  });
});

describe("nested workspace instruction epochs", () => {
  test("loads only instruction files related to referenced paths", async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, "src", "feature"), { recursive: true });
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "src", "AGENTS.md"), "Use src rules.");
    await writeFile(path.join(dir, "src", "CLAUDE.md"), "Ignored fallback.");
    await writeFile(path.join(dir, "docs", "AGENTS.md"), "Use docs rules.");
    await writeFile(path.join(dir, "src", "feature", "index.ts"), "export {};");

    const block = await buildNestedWorkspaceInstructionBlock({
      cwd: dir,
      relatedPaths: ["src/feature/index.ts"],
    });

    expect(block).toContain('source="src/AGENTS.md"');
    expect(block).toContain("Use src rules.");
    expect(block).not.toContain("Ignored fallback.");
    expect(block).not.toContain("Use docs rules.");
  });

  test("persists changed nested rules as chronological epochs", async () => {
    const dir = await tempDir();
    const dataDir = await tempDir();
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "AGENTS.md"), "First rules.");
    await writeFile(path.join(dir, "src", "index.ts"), "export {};");

    const first = await buildNestedWorkspaceInstructionBlock({
      cwd: dir,
      sessionId: "session-one",
      relatedPaths: ["src/index.ts"],
      dataDir,
    });
    await writeFile(path.join(dir, "src", "AGENTS.md"), "Second rules.");
    const second = await buildNestedWorkspaceInstructionBlock({
      cwd: dir,
      sessionId: "session-one",
      relatedPaths: ["src/index.ts"],
      dataDir,
    });

    expect(first).toContain('epoch="1"');
    expect(second).toContain(
      'epoch="1" source="src/AGENTS.md"',
    );
    expect(second).toContain('superseded="true"');
    expect(second).toContain('epoch="2" source="src/AGENTS.md"');
    expect(second).toContain('superseded="false"');
    expect(second).not.toContain("First rules.");
    expect(second).toContain("Second rules.");
  });

  test("collects typed file references and explicit tool input paths in order", () => {
    const messages = [
      {
        id: "user-1",
        role: "user",
        parts: [
          {
            type: "data-file-ref",
            data: {
              path: "src/a.ts",
              contentHash: `sha256:${"a".repeat(64)}`,
            },
          },
        ],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-read_file",
            toolCallId: "call-1",
            state: "input-available",
            input: { path: "src/b.ts" },
          },
        ],
      },
    ] as unknown as UIMessage[];

    expect(collectRelatedWorkspacePaths(messages)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });
});

describe("formatAvailableSkills", () => {
  test("returns empty string when there are no skills", () => {
    expect(formatAvailableSkills([])).toBe("");
  });

  test("renders names with optional descriptions", () => {
    const rendered = formatAvailableSkills([
      { name: "alpha", description: "first", path: "/a", source: "project" },
      { name: "beta", description: null, path: "/b", source: "user" },
    ]);

    expect(rendered).toContain("Available skills (load by name with the skill tool):");
    expect(rendered).toContain("- alpha: first");
    expect(rendered).toContain("- beta");
    expect(rendered).not.toContain("beta:");
  });

  test("keeps skills after the twentieth discoverable", () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      name: `skill-${index}`,
      description: null,
      path: `/s${index}`,
      source: "project" as const,
    }));

    const rendered = formatAvailableSkills(many);
    expect(rendered).toContain("skill-24");
    expect(rendered).not.toContain("more");
  });
});
