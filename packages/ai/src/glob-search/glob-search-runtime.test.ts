import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeCodingTool } from "../runtime-registry";

const tempRoots: string[] = [];

async function makeTempWorkspace() {
  const directory = await mkdtemp(path.join(tmpdir(), "lightcode-glob-"));
  tempRoots.push(directory);
  return directory;
}

async function writeWorkspaceFile(root: string, relativePath: string, content: string) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("glob_search runtime", () => {
  test("finds workspace files by glob pattern", async () => {
    const cwd = await makeTempWorkspace();
    await writeWorkspaceFile(cwd, "src/index.ts", "export {};");
    await writeWorkspaceFile(cwd, "src/index.test.ts", "test('x', () => {});");
    await writeWorkspaceFile(cwd, "README.md", "# demo");

    const output = await executeCodingTool(
      "glob_search",
      {
        pattern: "**/*.ts",
        path: ".",
        includeHidden: false,
        includeDirectories: false,
        maxResults: 10,
      },
      {
        cwd,
        mode: "plan",
        permissionMode: "read-only",
      },
    );

    expect(output.matches.map((match) => match.path).sort()).toEqual([
      "src/index.test.ts",
      "src/index.ts",
    ]);
    expect(output.truncated).toBe(false);
  });

  test("skips hidden entries unless requested", async () => {
    const cwd = await makeTempWorkspace();
    await writeWorkspaceFile(cwd, ".hidden/secret.ts", "secret");
    await writeWorkspaceFile(cwd, "visible.ts", "visible");

    const hiddenSkipped = await executeCodingTool(
      "glob_search",
      {
        pattern: "**/*.ts",
        path: ".",
        includeHidden: false,
        includeDirectories: false,
        maxResults: 100,
      },
      {
        cwd,
        mode: "plan",
        permissionMode: "read-only",
      },
    );

    const hiddenIncluded = await executeCodingTool(
      "glob_search",
      {
        pattern: "**/*.ts",
        path: ".",
        includeHidden: true,
        includeDirectories: false,
        maxResults: 100,
      },
      {
        cwd,
        mode: "plan",
        permissionMode: "read-only",
      },
    );

    expect(hiddenSkipped.matches.map((match) => match.path)).toEqual([
      "visible.ts",
    ]);
    expect(hiddenIncluded.matches.map((match) => match.path).sort()).toEqual([
      ".hidden/secret.ts",
      "visible.ts",
    ]);
  });
});
