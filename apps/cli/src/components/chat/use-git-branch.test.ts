import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readGitBranch } from "./use-git-branch";

const directories: string[] = [];

async function makeRepo(head: string) {
  const root = await mkdtemp(path.join(tmpdir(), "lightcode-branch-"));
  directories.push(root);
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, ".git", "HEAD"), head);
  return root;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("readGitBranch", () => {
  test("reads the branch from a nested folder", async () => {
    const root = await makeRepo("ref: refs/heads/feature/ui-polish\n");
    const nested = path.join(root, "apps", "cli");
    await mkdir(nested, { recursive: true });
    expect(await readGitBranch(nested)).toBe("feature/ui-polish");
  });

  test("shortens a detached HEAD and follows worktree pointers", async () => {
    const detached = await makeRepo("0123456789abcdef0123456789abcdef01234567\n");
    expect(await readGitBranch(detached)).toBe("0123456");

    const main = await makeRepo("ref: refs/heads/main\n");
    const worktreeGitDir = path.join(main, ".git", "worktrees", "wt");
    await mkdir(worktreeGitDir, { recursive: true });
    await writeFile(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/wt-branch\n");
    const worktree = await mkdtemp(path.join(tmpdir(), "lightcode-worktree-"));
    directories.push(worktree);
    await writeFile(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
    expect(await readGitBranch(worktree)).toBe("wt-branch");
  });
});
