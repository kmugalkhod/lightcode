import type { ChildProcess } from "node:child_process";
import { truncateText } from "../common/output-utils";
import {
  killProcessTree,
  RollingOutput,
  spawnShellCommand,
  waitForExit,
} from "./process";
import type { BackgroundJobReport, BackgroundJobStatus } from "./schema";

/** Background jobs one session may keep running at once. */
export const MAX_RUNNING_BACKGROUND_JOBS = 8;
/** Finished jobs kept readable before the oldest are forgotten. */
const maxFinishedJobsKept = 32;
/** Recent output kept per stream, so a chatty dev server cannot grow memory. */
const jobOutputCapacityChars = 200_000;
/** How long bash_stop waits for the process tree to go away. */
const stopWaitMs = 5_000;

interface BackgroundJob {
  id: string;
  sessionKey: string;
  command: string;
  child: ChildProcess;
  stdout: RollingOutput;
  stderr: RollingOutput;
  stdoutRead: number;
  stderrRead: number;
  status: BackgroundJobStatus;
  exitCode: number | null;
  exited: Promise<void>;
}

/**
 * Jobs live in the server process: they keep running across turns and end
 * with the server (the exit handler stops every one still running).
 */
const jobs = new Map<string, BackgroundJob>();
let nextJobNumber = 1;
let exitHandlerInstalled = false;

function installExitHandler() {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.once("exit", () => {
    for (const job of jobs.values()) {
      if (job.status === "running") killProcessTree(job.child, { sync: true });
    }
  });
}

function sessionJobs(sessionKey: string) {
  return [...jobs.values()].filter((job) => job.sessionKey === sessionKey);
}

function forgetOldFinishedJobs() {
  const finished = [...jobs.values()].filter((job) => job.status !== "running");
  for (const job of finished.slice(0, Math.max(0, finished.length - maxFinishedJobsKept))) {
    jobs.delete(job.id);
  }
}

export function startBackgroundJob({
  command,
  cwd,
  sessionKey,
  env,
}: {
  command: string;
  cwd: string;
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
}): { jobId: string } {
  const running = sessionJobs(sessionKey).filter((job) => job.status === "running");
  if (running.length >= MAX_RUNNING_BACKGROUND_JOBS) {
    throw new Error(
      `${running.length} background jobs are already running (${running.map((job) => job.id).join(", ")}). ` +
        "Stop one with bash_stop before starting another.",
    );
  }

  installExitHandler();
  forgetOldFinishedJobs();

  const child = spawnShellCommand(command, cwd, env);
  const job: BackgroundJob = {
    id: `bash-${nextJobNumber++}`,
    sessionKey,
    command,
    child,
    stdout: new RollingOutput(jobOutputCapacityChars),
    stderr: new RollingOutput(jobOutputCapacityChars),
    stdoutRead: 0,
    stderrRead: 0,
    status: "running",
    exitCode: null,
    exited: Promise.resolve(),
  };
  child.stdout?.on("data", (chunk: string) => job.stdout.append(chunk));
  child.stderr?.on("data", (chunk: string) => job.stderr.append(chunk));
  child.once("error", (error) => job.stderr.append(`${error.message}\n`));
  job.exited = waitForExit(child).then((code) => {
    job.exitCode = code ?? 1;
    if (job.status === "running") job.status = "exited";
  });
  jobs.set(job.id, job);
  return { jobId: job.id };
}

function findJob(jobId: string, sessionKey: string): BackgroundJob {
  const job = jobs.get(jobId.trim());
  if (job && job.sessionKey === sessionKey) return job;

  const known = sessionJobs(sessionKey).map((entry) => `${entry.id} (${entry.status}): ${entry.command}`);
  throw new Error(
    `No background job "${jobId}" in this session. ` +
      (known.length > 0
        ? `Known jobs: ${known.join("; ")}.`
        : "There are none — jobs end when the Lightcode server restarts."),
  );
}

/** Output produced since the previous read, then marks it read. */
function takeUnreadOutput(job: BackgroundJob, maxOutputChars: number) {
  const stdout = job.stdout.readFrom(job.stdoutRead);
  const stderr = job.stderr.readFrom(job.stderrRead);
  job.stdoutRead = job.stdout.end;
  job.stderrRead = job.stderr.end;

  const skippedNote = (skipped: number) =>
    skipped > 0 ? `... [${skipped} older characters were discarded before this read] ...\n` : "";
  const stdoutText = truncateText(`${skippedNote(stdout.skipped)}${stdout.text}`, maxOutputChars);
  const stderrText = truncateText(
    `${skippedNote(stderr.skipped)}${stderr.text}`,
    Math.max(2000, Math.floor(maxOutputChars / 4)),
  );
  return {
    stdout: stdoutText.text,
    stderr: stderrText.text,
    truncated:
      stdoutText.truncated || stderrText.truncated || stdout.skipped > 0 || stderr.skipped > 0,
  };
}

function report(job: BackgroundJob, maxOutputChars: number): BackgroundJobReport {
  return {
    jobId: job.id,
    command: job.command,
    status: job.status,
    exitCode: job.status === "running" ? null : job.exitCode,
    ...takeUnreadOutput(job, maxOutputChars),
  };
}

function delay(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || abortSignal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", done);
      resolve();
    }
    abortSignal?.addEventListener("abort", done, { once: true });
  });
}

export async function readBackgroundJob({
  jobId,
  sessionKey,
  waitMs,
  maxOutputChars,
  abortSignal,
}: {
  jobId: string;
  sessionKey: string;
  waitMs: number;
  maxOutputChars: number;
  abortSignal?: AbortSignal;
}): Promise<BackgroundJobReport> {
  const job = findJob(jobId, sessionKey);
  if (job.status === "running" && waitMs > 0) {
    await Promise.race([job.exited, delay(waitMs, abortSignal)]);
  }
  return report(job, maxOutputChars);
}

export async function stopBackgroundJob({
  jobId,
  sessionKey,
  maxOutputChars,
}: {
  jobId: string;
  sessionKey: string;
  maxOutputChars: number;
}): Promise<BackgroundJobReport> {
  const job = findJob(jobId, sessionKey);
  if (job.status === "running") {
    job.status = "stopped";
    killProcessTree(job.child);
    await Promise.race([job.exited, delay(stopWaitMs)]);
  }
  return report(job, maxOutputChars);
}

/** Stops every job still running; for tests and shutdown paths. */
export async function stopAllBackgroundJobs(): Promise<void> {
  const running = [...jobs.values()].filter((job) => job.status === "running");
  for (const job of running) {
    job.status = "stopped";
    killProcessTree(job.child);
  }
  await Promise.all(running.map((job) => Promise.race([job.exited, delay(stopWaitMs)])));
}
