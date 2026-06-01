import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createWorkspaceContext,
  resolveWithinWorkspace,
  toWorkspaceRelativePath,
} from "./resolve-within-workspace";

const tempRoots: string[] = [];

async function makeTempDirectory(label: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `lightcode-${label}-`));
  tempRoots.push(directory);
  return directory;
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

describe("resolveWithinWorkspace", () => {
  test("resolves existing paths and formats workspace-relative paths", async () => {
    const workspace = await makeTempDirectory("workspace");
    await writeFile(path.join(workspace, "inside.txt"), "hello", "utf8");
    const workspaceContext = createWorkspaceContext(workspace);

    const resolvedPath = resolveWithinWorkspace("inside.txt", {
      context: workspaceContext,
    });

    expect(resolvedPath).toBe(path.join(workspaceContext.root, "inside.txt"));
    expect(toWorkspaceRelativePath(resolvedPath, workspaceContext)).toBe(
      "inside.txt",
    );
  });

  test("blocks parent traversal for new write paths", async () => {
    const workspace = await makeTempDirectory("workspace");
    const workspaceContext = createWorkspaceContext(workspace);

    expect(() =>
      resolveWithinWorkspace("../outside.txt", {
        context: workspaceContext,
        allowMissing: true,
      }),
    ).toThrow(/escapes workspace/);
  });

  test("allows missing paths when their nearest existing parent is inside workspace", async () => {
    const workspace = await makeTempDirectory("workspace");
    const workspaceContext = createWorkspaceContext(workspace);

    const resolvedPath = resolveWithinWorkspace("nested/new-file.txt", {
      context: workspaceContext,
      allowMissing: true,
    });

    expect(resolvedPath).toBe(path.join(workspaceContext.root, "nested", "new-file.txt"));
  });

  test("blocks symlink escape for existing reads and new writes", async () => {
    const workspace = await makeTempDirectory("workspace");
    const outside = await makeTempDirectory("outside");
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");

    const linkPath = path.join(workspace, "outside-link");
    await symlink(
      outside,
      linkPath,
      process.platform === "win32" ? "junction" : "dir",
    );

    const workspaceContext = createWorkspaceContext(workspace);

    expect(() =>
      resolveWithinWorkspace("outside-link/secret.txt", {
        context: workspaceContext,
      }),
    ).toThrow(/escapes workspace/);
    expect(() =>
      resolveWithinWorkspace("outside-link/new-file.txt", {
        context: workspaceContext,
        allowMissing: true,
      }),
    ).toThrow(/escapes workspace/);
  });
});
