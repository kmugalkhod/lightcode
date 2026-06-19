import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWorkspaceContext } from "./workspace-context";

const tempDir = () => mkdtemp(path.join(tmpdir(), "lc-ws-"));

describe("buildWorkspaceContext", () => {
  test("includes cwd, top-level listing, and project docs; degrades for non-git dirs", async () => {
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

  test("truncates oversized project docs and stays bounded", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "README.md"), "x".repeat(50_000));

    const block = await buildWorkspaceContext({ cwd: dir });

    expect(block).toContain("truncated");
    expect(block.length).toBeLessThanOrEqual(8_200);
  });

  test("never throws for a missing directory", async () => {
    const block = await buildWorkspaceContext({
      cwd: path.join(tmpdir(), "lc-does-not-exist-xyz"),
    });
    expect(block).toContain("<environment>");
  });
});
