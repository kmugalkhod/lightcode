import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { executeCodingTool } from "../runtime-registry";
import { bashInputSchema } from "./schema";
import { stopAllBackgroundJobs } from "./runtime";

const tempRoots: string[] = [];

async function makeTempWorkspace() {
  const directory = await mkdtemp(path.join(tmpdir(), "lightcode-bash-jobs-"));
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

function options(cwd: string, sessionId = "session-a") {
  return {
    cwd,
    mode: "build" as const,
    permissionMode: "danger-full-access" as const,
    sessionId,
  };
}

function bash(cwd: string, input: { command: string; timeoutMs?: number; runInBackground?: boolean }, sessionId?: string) {
  return executeCodingTool(
    "bash",
    { timeoutMs: 10_000, maxOutputChars: 4_000, ...input },
    options(cwd, sessionId),
  );
}

afterEach(async () => {
  await stopAllBackgroundJobs();
  for (const directory of tempRoots.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await rm(directory, { recursive: true, force: true });
        break;
      } catch {
        await delay(200);
      }
    }
  }
});

afterAll(async () => {
  await stopAllBackgroundJobs();
});

describe("bash timeouts", () => {
  test("defaults to two minutes and clamps out-of-range values instead of rejecting them", () => {
    expect(bashInputSchema.parse({ command: "x" }).timeoutMs).toBe(120_000);
    expect(bashInputSchema.parse({ command: "x", timeoutMs: 900_000 }).timeoutMs).toBe(600_000);
    expect(bashInputSchema.parse({ command: "x", timeoutMs: 5 }).timeoutMs).toBe(1_000);
  });

  test("says the command timed out and stops what it started", async () => {
    const cwd = await makeTempWorkspace();
    // The parent starts a grandchild that would write a file after the timeout.
    await writeFile(
      path.join(cwd, "late-writer.js"),
      "setTimeout(() => require('fs').writeFileSync('late.txt', 'x'), 2500); setTimeout(() => {}, 10000);",
    );
    await writeFile(
      path.join(cwd, "parent.js"),
      "require('child_process').spawn(process.execPath, ['late-writer.js'], { stdio: 'inherit' }); setTimeout(() => {}, 10000);",
    );

    const output = await bash(cwd, { command: "bun parent.js", timeoutMs: 1_000 });

    expect(output.exitCode).not.toBe(0);
    expect(output.timedOut).toBe(true);
    expect(output.stderr).toContain("timed out after 1s");
    await delay(3_000);
    expect(await pathExists(path.join(cwd, "late.txt"))).toBe(false);
  }, 15_000);

  test("returns once the command exits even if a leftover process holds its output open", async () => {
    const cwd = await makeTempWorkspace();
    await writeFile(
      path.join(cwd, "leave-behind.js"),
      // Like `cmd &` or `start /B`: the child outlives its parent and keeps the inherited pipes.
      "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'inherit', cwd: require('os').tmpdir() }).unref(); console.log('parent done');",
    );

    const started = Date.now();
    const output = await bash(cwd, { command: "bun leave-behind.js" });

    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("parent done");
    expect(Date.now() - started).toBeLessThan(3_500);
  }, 15_000);

  test("rg works in commands without the user installing ripgrep", async () => {
    const cwd = await makeTempWorkspace();
    const output = await bash(cwd, { command: "rg --version", timeoutMs: 10_000 });

    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("ripgrep");
  }, 15_000);

  test("gives commands an empty stdin instead of leaving them waiting", async () => {
    const cwd = await makeTempWorkspace();
    await writeFile(
      path.join(cwd, "read-stdin.js"),
      "let text = ''; process.stdin.on('data', (c) => { text += c; }); process.stdin.on('end', () => { console.log('stdin closed:' + text.length); });",
    );

    const output = await bash(cwd, { command: "bun read-stdin.js", timeoutMs: 5_000 });

    expect(output.timedOut).toBeUndefined();
    expect(output.stdout).toContain("stdin closed:0");
  }, 15_000);
});

describe("background bash jobs", () => {
  test("a job keeps running; bash_output returns only new output; bash_stop ends it", async () => {
    const cwd = await makeTempWorkspace();
    await writeFile(
      path.join(cwd, "server.js"),
      "console.log('listening on 5173'); setInterval(() => console.log('tick'), 300);",
    );

    const started = await bash(cwd, { command: "bun server.js", runInBackground: true });
    expect(started.exitCode).toBeNull();
    const jobId = started.backgroundJobId;
    expect(jobId).toMatch(/^bash-\d+$/);

    const first = await executeCodingTool("bash_output", { jobId: jobId!, waitMs: 1_000, maxOutputChars: 4_000 }, options(cwd));
    expect(first.status).toBe("running");
    expect(first.exitCode).toBeNull();
    expect(first.stdout).toContain("listening on 5173");

    const second = await executeCodingTool("bash_output", { jobId: jobId!, waitMs: 700, maxOutputChars: 4_000 }, options(cwd));
    expect(second.stdout).not.toContain("listening on 5173");
    expect(second.stdout).toContain("tick");

    const stopped = await executeCodingTool("bash_stop", { jobId: jobId! }, options(cwd));
    expect(stopped.status).toBe("stopped");

    await delay(500);
    const after = await executeCodingTool("bash_output", { jobId: jobId!, waitMs: 0, maxOutputChars: 4_000 }, options(cwd));
    expect(after.status).toBe("stopped");
    expect(after.exitCode).not.toBeNull();
  }, 20_000);

  test("waitMs returns as soon as the job exits, with its exit code", async () => {
    const cwd = await makeTempWorkspace();
    const started = await bash(cwd, {
      command: 'bun -e "console.log(\'built\'); process.exit(3)"',
      runInBackground: true,
    });

    const begin = Date.now();
    const done = await executeCodingTool(
      "bash_output",
      { jobId: started.backgroundJobId!, waitMs: 20_000, maxOutputChars: 4_000 },
      options(cwd),
    );

    expect(Date.now() - begin).toBeLessThan(10_000);
    expect(done.status).toBe("exited");
    expect(done.exitCode).toBe(3);
    expect(done.stdout).toContain("built");
  }, 30_000);

  test("jobs belong to the session that started them", async () => {
    const cwd = await makeTempWorkspace();
    const started = await bash(cwd, { command: 'bun -e "setTimeout(() => {}, 10000)"', runInBackground: true }, "session-a");

    await expect(
      executeCodingTool("bash_output", { jobId: started.backgroundJobId!, waitMs: 0, maxOutputChars: 4_000 }, options(cwd, "session-b")),
    ).rejects.toThrow(/No background job/);
    await expect(
      executeCodingTool("bash_stop", { jobId: "bash-999999" }, options(cwd, "session-a")),
    ).rejects.toThrow(started.backgroundJobId!);
  }, 15_000);
});
