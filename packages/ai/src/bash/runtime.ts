import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  getDefaultWorkspaceContext,
  type WorkspaceContext,
} from "../common/resolve-within-workspace";
import { truncateText } from "../common/output-utils";
import { bashInputSchema, bashOutputSchema } from "./schema";

const execAsync = promisify(exec);
type BashInput = z.input<typeof bashInputSchema>;
type BashOutput = z.infer<typeof bashOutputSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function getStringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getNumericExitCode(record: Record<string, unknown>): number {
  const value = record.code;
  return typeof value === "number" ? value : 1;
}

export async function executeBash(
  input: BashInput,
  workspaceContext: WorkspaceContext = getDefaultWorkspaceContext(),
): Promise<BashOutput> {
  const parsedInput = bashInputSchema.parse(input);

  try {
    const result = await execAsync(parsedInput.command, {
      cwd: workspaceContext.root,
      timeout: parsedInput.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });

    const stdoutTruncated = truncateText(result.stdout, parsedInput.maxOutputChars);
    const stderrTruncated = truncateText(result.stderr, Math.max(2000, Math.floor(parsedInput.maxOutputChars / 4)));

    return bashOutputSchema.parse({
      command: parsedInput.command,
      cwd: workspaceContext.root,
      stdout: stdoutTruncated.text,
      stderr: stderrTruncated.text,
      exitCode: 0,
      truncated: stdoutTruncated.truncated || stderrTruncated.truncated,
    });
  } catch (error) {
    const errorRecord = toRecord(error);
    const stdout = getStringProperty(errorRecord, "stdout") ?? "";
    const stderr =
      getStringProperty(errorRecord, "stderr") ??
      getStringProperty(errorRecord, "message") ??
      "Command failed.";
    const stdoutTruncated = truncateText(stdout, parsedInput.maxOutputChars);
    const stderrTruncated = truncateText(stderr, Math.max(2000, Math.floor(parsedInput.maxOutputChars / 4)));

    return bashOutputSchema.parse({
      command: parsedInput.command,
      cwd: workspaceContext.root,
      stdout: stdoutTruncated.text,
      stderr: stderrTruncated.text,
      exitCode: getNumericExitCode(errorRecord),
      truncated: stdoutTruncated.truncated || stderrTruncated.truncated,
    });
  }
}
