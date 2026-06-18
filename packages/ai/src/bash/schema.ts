import { z } from "zod";
import {
  DEFAULT_TOOL_TEXT_OUTPUT_CHARS,
  MAX_TOOL_TEXT_OUTPUT_CHARS,
} from "../constants";
import { integerRangeSchema } from "../common/base-schemas";

export const bashDescription =
  "Run a shell command from workspace root with a timeout. Bound noisy output at the source (head/tail/grep/wc, or write to a file then read a range) rather than dumping everything — output is truncated head+tail and wastes tokens. Commands are classified before execution and may require approval.";

export const bashInputSchema = z.object({
  command: z.string().min(1).max(4000),
  timeoutMs: integerRangeSchema(1_000, 120_000, "timeoutMs").optional().default(30_000),
  maxOutputChars: integerRangeSchema(200, MAX_TOOL_TEXT_OUTPUT_CHARS, "maxOutputChars")
    .optional()
    .default(DEFAULT_TOOL_TEXT_OUTPUT_CHARS),
});

// Provider-facing schema remains tiny to stay under provider grammar limits.
export const bashProviderInputSchema = z.object({
  command: z.string().min(1).max(4000),
});

export const bashOutputSchema = z.object({
  command: z.string(),
  cwd: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  truncated: z.boolean(),
});
