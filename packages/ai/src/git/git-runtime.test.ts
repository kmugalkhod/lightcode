import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { executeCodingTool } from "../runtime-registry";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function makeTempWorkspace() {
  const directory = await mkdtemp(path.join(tmpdir(), "lightcode-git-"));
  tempRoots.push(directory);
  return directory;
}

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
  });
}

async function isGitAvailable() {
  try {
    await execFileAsync("git", ["--version"], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function writeWorkspaceFile(root: string, relativePath: string, content: string) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function initGitRepo(cwd: string) {
  await runGit(cwd, ["init"]);
  await runGit(cwd, ["config", "user.email", "test@example.com"]);
  await runGit(cwd, ["config", "user.name", "Lightcode Test"]);
  await writeWorkspaceFile(cwd, "tracked.txt", "before\n");
  await runGit(cwd, ["add", "tracked.txt"]);
  await runGit(cwd, ["commit", "-m", "Initial commit"]);
}

async function removeWithRetry(directory: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(directory, {
        recursive: true,
        force: true,
      });
      return;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        Reflect.get(error, "code") === "EBUSY"
      ) {
        await delay(100);
        continue;
      }

      throw error;
    }
  }
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((directory) => removeWithRetry(directory)),
  );
});

describe("structured git runtimes", () => {
  test("returns status, diff, log, and show data", async () => {
    if (!(await isGitAvailable())) {
      return;
    }

    const cwd = await makeTempWorkspace();
    await initGitRepo(cwd);
    await writeWorkspaceFile(cwd, "tracked.txt", "before\nafter\n");
    await writeWorkspaceFile(cwd, "untracked.txt", "new\n");

    const status = await executeCodingTool(
      "git_status",
      { maxEntries: 100 },
      {
        cwd,
        mode: "plan",
        permissionMode: "read-only",
      },
    );
    const diff = await executeCodingTool(
      "git_diff",
      {
        path: "tracked.txt",
        staged: false,
        statOnly: false,
        maxChars: 12000,
      },
      {
        cwd,
        mode: "plan",
        permissionMode: "read-only",
      },
    );
    const log = await executeCodingTool(
      "git_log",
      {
        path: undefined,
        maxCommits: 5,
      },
      {
        cwd,
        mode: "plan",
        permissionMode: "read-only",
      },
    );
    const show = await executeCodingTool(
      "git_show",
      {
        revision: "HEAD",
        path: undefined,
        maxChars: 1000,
      },
      {
        cwd,
        mode: "plan",
        permissionMode: "read-only",
      },
    );

    expect(status.ok).toBe(true);
    expect(status.entries.some((entry) => entry.path === "tracked.txt")).toBe(true);
    expect(status.entries.some((entry) => entry.path === "untracked.txt")).toBe(true);
    expect(diff.ok).toBe(true);
    expect(diff.diff).toContain("+after");
    expect(log.ok).toBe(true);
    expect(log.commits[0].subject).toBe("Initial commit");
    expect(show.ok).toBe(true);
    expect(show.content).toContain("Initial commit");
  }, 30_000);
});
