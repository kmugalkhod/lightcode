import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildNestedWorkspaceInstructionBlock,
  buildWorkspaceContext,
  buildWorkspaceInstructionBaseline,
  collectRelatedWorkspacePaths,
  formatAvailableSkills,
  formatRepositoryMap,
  resetEnvironmentSnapshotMemo,
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
    expect(block.length).toBeLessThanOrEqual(24_200);
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

describe("formatRepositoryMap", () => {
  test("renders folders before files with recursive file counts", () => {
    const map = formatRepositoryMap([
      "README.md",
      "src/index.ts",
      "src/lib/a.ts",
      "src/lib/b.ts",
    ]);

    expect(map.split("\n")).toEqual([
      "src/ (3)",
      "  lib/ (2)",
      "    a.ts",
      "    b.ts",
      "  index.ts",
      "README.md",
    ]);
  });

  test("stays within budget, keeping the folder skeleton over file names", () => {
    const paths: string[] = [];
    for (let pkg = 0; pkg < 20; pkg += 1) {
      for (let file = 0; file < 200; file += 1) {
        paths.push(`packages/pkg-${pkg}/src/deep/module-${file}.ts`);
      }
    }

    const map = formatRepositoryMap(paths, 1_500);

    expect(map.length).toBeLessThanOrEqual(1_500);
    expect(map).toContain("pkg-19/ (200)");
    // File names give way first: a collapsed folder still states its size.
    expect(map).toContain("… 200 files");
    expect(map).not.toContain("module-199.ts");
  });

  test("lists dot-folders collapsed and caps wide folders", () => {
    const paths = [
      ".github/workflows/ci.yml",
      ...Array.from({ length: 40 }, (_, index) => `wide/file-${String(index).padStart(2, "0")}.ts`),
    ];

    const map = formatRepositoryMap(paths);

    expect(map).toContain(".github/ (1)");
    expect(map).not.toContain("ci.yml");
    expect(map).toContain("… 8 more files");
  });
});

describe("buildWorkspaceContext session snapshot", () => {
  test("maps the repository's files for git workspaces", async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "index.ts"), "export {};");
    await writeFile(path.join(dir, ".gitignore"), "dist/\n");
    await mkdir(path.join(dir, "dist"));
    await writeFile(path.join(dir, "dist", "bundle.js"), "");
    execFileSync("git", ["init", "-q"], { cwd: dir });

    const block = await buildWorkspaceContext({ cwd: dir });

    expect(block).toContain("Repository files (2;");
    expect(block).toContain("src/ (1)");
    expect(block).toContain("  index.ts");
    // Ignored output never reaches the map.
    expect(block).not.toContain("bundle.js");
  });

  test("replays the session's environment verbatim across turns", async () => {
    const dir = await tempDir();
    const dataDir = await tempDir();
    await writeFile(path.join(dir, "AGENTS.md"), "Always run bun test.");
    await mkdir(path.join(dir, "src"));

    const first = await buildWorkspaceContext({
      cwd: dir,
      sessionId: "session-stable",
      dataDir,
    });
    // Workspace changes mid-session must not rewrite the cached prompt prefix.
    await writeFile(path.join(dir, "added-later.ts"), "export {};");
    const second = await buildWorkspaceContext({
      cwd: dir,
      sessionId: "session-stable",
      dataDir,
    });

    expect(second).toBe(first);
    expect(second).toContain("Top-level entries:");
    expect(second).not.toContain("added-later.ts");
  });

  test("survives a server restart through the persisted snapshot", async () => {
    const dir = await tempDir();
    const dataDir = await tempDir();
    const first = await buildWorkspaceContext({
      cwd: dir,
      sessionId: "session-restart",
      dataDir,
    });
    await writeFile(path.join(dir, "added-later.ts"), "export {};");
    resetEnvironmentSnapshotMemo();

    // After a restart the persisted file, not the in-process memo, must
    // reproduce the block byte-for-byte; a new session gets its own snapshot.
    const other = await buildWorkspaceContext({
      cwd: dir,
      sessionId: "session-other",
      dataDir,
    });
    const again = await buildWorkspaceContext({
      cwd: dir,
      sessionId: "session-restart",
      dataDir,
    });

    expect(again).toBe(first);
    expect(other).toContain("added-later.ts");
  });

  test("still refreshes root instructions within a session", async () => {
    const dir = await tempDir();
    const dataDir = await tempDir();
    await writeFile(path.join(dir, "AGENTS.md"), "Use Bun.");
    const first = await buildWorkspaceContext({
      cwd: dir,
      sessionId: "session-instructions",
      dataDir,
    });
    await writeFile(path.join(dir, "AGENTS.md"), "Use Bun and run tests.");
    const second = await buildWorkspaceContext({
      cwd: dir,
      sessionId: "session-instructions",
      dataDir,
    });

    expect(first).toContain("Use Bun.");
    expect(second).toContain("Use Bun and run tests.");
  });

  test("session-less builds reflect the current workspace", async () => {
    const dir = await tempDir();
    await buildWorkspaceContext({ cwd: dir });
    await writeFile(path.join(dir, "added-later.ts"), "export {};");

    expect(await buildWorkspaceContext({ cwd: dir })).toContain(
      "added-later.ts",
    );
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
