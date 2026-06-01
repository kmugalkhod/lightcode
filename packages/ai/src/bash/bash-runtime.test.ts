import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  executeCodingTool,
  isPermissionDeniedError,
} from "../runtime-registry";

const tempRoots: string[] = [];

async function makeTempWorkspace() {
  const directory = await mkdtemp(path.join(tmpdir(), "lightcode-bash-"));
  tempRoots.push(directory);
  return directory;
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
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

describe("bash runtime safety", () => {
  test("returns timeout failures without throwing", async () => {
    const cwd = await makeTempWorkspace();
    const output = await executeCodingTool(
      "bash",
      {
        command: 'bun -e "setTimeout(function(){}, 5000)"',
        timeoutMs: 1000,
        maxOutputChars: 200,
      },
      {
        cwd,
        mode: "build",
        permissionMode: "danger-full-access",
      },
    );

    expect(output.exitCode).not.toBe(0);
  });

  test("truncates large output", async () => {
    const cwd = await makeTempWorkspace();
    const output = await executeCodingTool(
      "bash",
      {
        command: 'bun -e "console.log(\'x\'.repeat(1000))"',
        timeoutMs: 5000,
        maxOutputChars: 200,
      },
      {
        cwd,
        mode: "build",
        permissionMode: "danger-full-access",
      },
    );

    expect(output.exitCode).toBe(0);
    expect(output.truncated).toBe(true);
    expect(output.stdout.length).toBeLessThanOrEqual(200);
  });

  test("returns command failure output", async () => {
    const cwd = await makeTempWorkspace();
    const output = await executeCodingTool(
      "bash",
      {
        command: 'bun -e "console.error(\'boom\'); process.exit(7)"',
        timeoutMs: 5000,
        maxOutputChars: 200,
      },
      {
        cwd,
        mode: "build",
        permissionMode: "danger-full-access",
      },
    );

    expect(output.exitCode).toBe(7);
    expect(output.stderr).toContain("boom");
  });

  test("denies dangerous shell commands before execution", async () => {
    const cwd = await makeTempWorkspace();
    const targetPath = path.join(cwd, "should-not-exist.txt");

    try {
      await executeCodingTool(
        "bash",
        {
          command: 'bun -e "Bun.write(\'should-not-exist.txt\', \'bad\')"',
          timeoutMs: 5000,
          maxOutputChars: 200,
        },
        {
          cwd,
          mode: "build",
          permissionMode: "workspace-write",
        },
      );
      throw new Error("Expected command to be denied before execution.");
    } catch (error) {
      expect(isPermissionDeniedError(error)).toBe(true);
    }

    expect(await pathExists(targetPath)).toBe(false);
  });
});
