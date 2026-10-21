import { z } from "zod";
import { DEFAULT_TOOL_TEXT_OUTPUT_CHARS } from "../constants";
import {
  getDefaultWorkspaceContext,
  type WorkspaceContext,
} from "../common/resolve-within-workspace";
import { truncateText } from "../common/output-utils";
import { withBundledRipgrepOnPath } from "../grep/ripgrep";
import { stopSocketInheritance } from "../common/socket-inheritance";
import {
  readBackgroundJob,
  startBackgroundJob,
  stopBackgroundJob,
} from "./background-jobs";
import {
  HeadTailOutput,
  killProcessTree,
  spawnShellCommand,
  waitForExit,
} from "./process";
import {
  backgroundJobReportSchema,
  bashInputSchema,
  bashOutputSchema,
  bashOutputToolInputSchema,
  bashStopToolInputSchema,
  type BackgroundJobReport,
} from "./schema";
import { resolveCommandShell } from "./shell";

type BashInput = z.input<typeof bashInputSchema>;
type BashOutput = z.infer<typeof bashOutputSchema>;

/** Output kept per stream before the middle is dropped (then truncated to maxOutputChars). */
const capturedOutputHalfLimit = 256_000;

export interface BashRuntimeOptions {
  abortSignal?: AbortSignal;
  /** Scopes background jobs to the chat session that started them. */
  sessionId?: string;
}

function stderrLimit(maxOutputChars: number) {
  return Math.max(2000, Math.floor(maxOutputChars / 4));
}

function formatDuration(ms: number) {
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)}s`;
}

export async function executeBash(
  input: BashInput,
  workspaceContext: WorkspaceContext = getDefaultWorkspaceContext(),
  { abortSignal, sessionId }: BashRuntimeOptions = {},
): Promise<BashOutput> {
  const parsedInput = bashInputSchema.parse(input);
  const cwd = workspaceContext.root;
  // cmd.exe would run the first line, skip the rest, and report success.
  if (resolveCommandShell().kind === "cmd" && /[\r\n]/.test(parsedInput.command.trim())) {
    return bashOutputSchema.parse({
      command: parsedInput.command,
      cwd,
      stdout: "",
      stderr:
        "Not run: commands here go to cmd.exe, which runs only the first line of a multi-line command. " +
        "Write the script to a file and run that, or join the commands with && on one line.",
      exitCode: 1,
      truncated: false,
    });
  }
  // Models reach for `rg` in shell commands; the bundled copy makes it work.
  const env = await withBundledRipgrepOnPath(process.env);
  // A command may leave a process running (`start /B`, an editor); it must not
  // take the server's sockets with it.
  await stopSocketInheritance();

  if (parsedInput.runInBackground) {
    const { jobId } = startBackgroundJob({
      command: parsedInput.command,
      cwd,
      sessionKey: sessionId ?? "",
      env,
    });
    return bashOutputSchema.parse({
      command: parsedInput.command,
      cwd,
      stdout: "",
      stderr: "",
      exitCode: null,
      truncated: false,
      backgroundJobId: jobId,
      message: `Started in the background as ${jobId}. Read its output with bash_output and stop it with bash_stop.`,
    });
  }

  abortSignal?.throwIfAborted();
  const child = spawnShellCommand(parsedInput.command, cwd, env);
  const stdout = new HeadTailOutput(capturedOutputHalfLimit);
  const stderr = new HeadTailOutput(capturedOutputHalfLimit);
  child.stdout?.on("data", (chunk: string) => stdout.append(chunk));
  child.stderr?.on("data", (chunk: string) => stderr.append(chunk));
  child.once("error", (error) => stderr.append(`${error.message}\n`));

  let timedOut = false;
  let cancelled = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessTree(child);
  }, parsedInput.timeoutMs);
  const cancel = () => {
    cancelled = true;
    killProcessTree(child);
  };
  abortSignal?.addEventListener("abort", cancel, { once: true });

  const code = await waitForExit(child);
  clearTimeout(timeout);
  abortSignal?.removeEventListener("abort", cancel);

  if (timedOut) {
    stderr.append(
      `\nCommand timed out after ${formatDuration(parsedInput.timeoutMs)} and was stopped. ` +
        "Re-run it with a larger timeoutMs (max 600000), or with runInBackground: true if it keeps running (dev servers, watchers).",
    );
  } else if (cancelled) {
    stderr.append("\nCommand was cancelled.");
  }

  const stdoutTruncated = truncateText(stdout.toString(), parsedInput.maxOutputChars);
  const stderrTruncated = truncateText(stderr.toString(), stderrLimit(parsedInput.maxOutputChars));
  // A killed command never reports success, even if its shell exited 0.
  const exitCode = code ?? 1;

  return bashOutputSchema.parse({
    command: parsedInput.command,
    cwd,
    stdout: stdoutTruncated.text,
    stderr: stderrTruncated.text,
    exitCode: (timedOut || cancelled) && exitCode === 0 ? 1 : exitCode,
    truncated: stdoutTruncated.truncated || stderrTruncated.truncated,
    ...(timedOut ? { timedOut: true } : {}),
  });
}

export async function executeBashOutput(
  input: z.input<typeof bashOutputToolInputSchema>,
  { abortSignal, sessionId }: BashRuntimeOptions = {},
): Promise<BackgroundJobReport> {
  const parsedInput = bashOutputToolInputSchema.parse(input);
  return backgroundJobReportSchema.parse(
    await readBackgroundJob({
      jobId: parsedInput.jobId,
      sessionKey: sessionId ?? "",
      waitMs: parsedInput.waitMs,
      maxOutputChars: parsedInput.maxOutputChars,
      abortSignal,
    }),
  );
}

export async function executeBashStop(
  input: z.input<typeof bashStopToolInputSchema>,
  { sessionId }: BashRuntimeOptions = {},
): Promise<BackgroundJobReport> {
  const parsedInput = bashStopToolInputSchema.parse(input);
  return backgroundJobReportSchema.parse(
    await stopBackgroundJob({
      jobId: parsedInput.jobId,
      sessionKey: sessionId ?? "",
      maxOutputChars: DEFAULT_TOOL_TEXT_OUTPUT_CHARS,
    }),
  );
}

export { stopAllBackgroundJobs } from "./background-jobs";
