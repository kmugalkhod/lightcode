import { z } from "zod";
import {
  DEFAULT_TOOL_TEXT_OUTPUT_CHARS,
  MAX_TOOL_TEXT_OUTPUT_CHARS,
} from "../constants";
import { integerRangeSchema } from "../common/base-schemas";

export const BASH_MIN_TIMEOUT_MS = 1_000;
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 600_000;
export const BASH_MAX_WAIT_MS = 600_000;

export const bashDescription =
  "Run a shell command from workspace root. It is stopped after timeoutMs (default 120000 = 2 minutes, max 600000 = 10 minutes) — pass a larger timeoutMs for long builds, installs, and test suites. " +
  "Set runInBackground: true for dev servers, watchers, and anything else that keeps running: the call returns a backgroundJobId at once; read the job with bash_output and stop it with bash_stop. " +
  "Bound noisy output at the source (head/tail/grep/wc) — output is truncated head+tail. Commands may require approval.";

export const bashOutputToolDescription =
  "Read a background bash job (started with runInBackground): its output since your last read and whether it is still running. " +
  "Set waitMs to wait up to that long for the job to finish first (max 600000); it returns as soon as the job exits.";

export const bashStopToolDescription =
  "Stop a background bash job and every process it started. Returns its last unread output.";

/** Out-of-range numbers are clamped: a model asking for 15 minutes gets 10, not an error. */
function clampedMs(min: number, max: number) {
  return z
    .number()
    .finite()
    .transform((value) => Math.min(max, Math.max(min, Math.round(value))));
}

export const bashInputSchema = z.object({
  command: z.string().min(1).max(4000),
  timeoutMs: clampedMs(BASH_MIN_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS)
    .optional()
    .default(BASH_DEFAULT_TIMEOUT_MS),
  runInBackground: z.boolean().optional(),
  maxOutputChars: integerRangeSchema(200, MAX_TOOL_TEXT_OUTPUT_CHARS, "maxOutputChars")
    .optional()
    .default(DEFAULT_TOOL_TEXT_OUTPUT_CHARS),
});

/**
 * Sent without strict mode (see the registry), so its options do not count
 * against the strict optional-parameter budget.
 */
export const bashProviderInputSchema = z.object({
  command: z.string().min(1).max(4000),
  timeoutMs: z.number().optional(),
  runInBackground: z.boolean().optional(),
});

export const bashOutputSchema = z.object({
  command: z.string(),
  cwd: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  /** Null while a background job runs. */
  exitCode: z.number().int().nullable(),
  truncated: z.boolean(),
  /** Present when the command was stopped at its timeout. */
  timedOut: z.boolean().optional(),
  /** Present when the command was started with runInBackground. */
  backgroundJobId: z.string().optional(),
  message: z.string().optional(),
});

const backgroundJobIdSchema = z.string().trim().min(1).max(64);

export const bashOutputToolInputSchema = z.object({
  jobId: backgroundJobIdSchema,
  waitMs: clampedMs(0, BASH_MAX_WAIT_MS).optional().default(0),
  maxOutputChars: integerRangeSchema(200, MAX_TOOL_TEXT_OUTPUT_CHARS, "maxOutputChars")
    .optional()
    .default(DEFAULT_TOOL_TEXT_OUTPUT_CHARS),
});

export const bashOutputToolProviderInputSchema = z.object({
  jobId: backgroundJobIdSchema,
  waitMs: z.number().optional(),
});

export const bashStopToolInputSchema = z.object({
  jobId: backgroundJobIdSchema,
});

export const bashStopToolProviderInputSchema = bashStopToolInputSchema;

export const backgroundJobStatusSchema = z.enum(["running", "exited", "stopped"]);

/** What bash_output and bash_stop report about a background job. */
export const backgroundJobReportSchema = z.object({
  jobId: z.string(),
  command: z.string(),
  status: backgroundJobStatusSchema,
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
});

export type BackgroundJobStatus = z.infer<typeof backgroundJobStatusSchema>;
export type BackgroundJobReport = z.infer<typeof backgroundJobReportSchema>;
