import { exec } from "node:child_process";
import { promisify } from "node:util";
import { WORKSPACE } from "../common/resolve-within-workspace";
import { truncateText } from "../common/output-utils";
import { bashInputSchema, bashOutputSchema } from "./schema";

const execAsync = promisify(exec);

export async function executeBash(input: unknown) {
  const parsedInput = bashInputSchema.parse(input);

  try {
    const result = await execAsync(parsedInput.command, {
      cwd: WORKSPACE,
      timeout: parsedInput.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });

    const stdoutTruncated = truncateText(result.stdout, parsedInput.maxOutputChars);
    const stderrTruncated = truncateText(result.stderr, Math.max(2000, Math.floor(parsedInput.maxOutputChars / 4)));

    return bashOutputSchema.parse({
      command: parsedInput.command,
      cwd: WORKSPACE,
      stdout: stdoutTruncated.text,
      stderr: stderrTruncated.text,
      exitCode: 0,
      truncated: stdoutTruncated.truncated || stderrTruncated.truncated,
    });
  } catch (error) {
    const maybeError = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
      code?: string | number;
    };

    const stdout = maybeError.stdout ?? "";
    const stderr = maybeError.stderr ?? maybeError.message ?? "Command failed.";
    const stdoutTruncated = truncateText(stdout, parsedInput.maxOutputChars);
    const stderrTruncated = truncateText(stderr, Math.max(2000, Math.floor(parsedInput.maxOutputChars / 4)));

    return bashOutputSchema.parse({
      command: parsedInput.command,
      cwd: WORKSPACE,
      stdout: stdoutTruncated.text,
      stderr: stderrTruncated.text,
      exitCode: typeof maybeError.code === "number" ? maybeError.code : 1,
      truncated: stdoutTruncated.truncated || stderrTruncated.truncated,
    });
  }
}
