import { z } from "zod";
import { MAX_TOOL_SEARCH_RESULTS } from "../constants";
import { boundedPathSchema, integerRangeSchema } from "../common/base-schemas";

export const GREP_MAX_CONTEXT_LINES = 10;

export const grepDescription =
  "Search file contents under path for text, or for a regex with isRegex; .gitignore'd files are skipped. Returns file, line number, and line for each match. " +
  'glob limits which files are searched (e.g. "*.ts", "src/**/*.{ts,tsx}", "!*.test.ts"). ' +
  "context adds that many lines before and after each match (max 10). " +
  'outputMode "files" lists the matching files with how many lines match in each, instead of the lines — use it to see where something is used before reading.';

export const grepOutputModeSchema = z.enum(["content", "files"]);

export const grepInputSchema = z.object({
  query: z.string().min(1).max(1000),
  path: boundedPathSchema.optional().default("."),
  isRegex: z.boolean().optional().default(false),
  caseSensitive: z.boolean().optional().default(false),
  glob: z.string().trim().min(1).max(500).optional(),
  /** Out-of-range values are clamped rather than rejected. */
  context: z
    .number()
    .finite()
    .transform((value) => Math.min(GREP_MAX_CONTEXT_LINES, Math.max(0, Math.round(value))))
    .optional()
    .default(0),
  outputMode: grepOutputModeSchema.optional().default("content"),
  maxResults: integerRangeSchema(1, MAX_TOOL_SEARCH_RESULTS, "maxResults").optional().default(50),
});

/**
 * Sent without strict mode (see the registry), so its options do not count
 * against the strict optional-parameter budget.
 */
export const grepProviderInputSchema = z.object({
  query: z.string().min(1).max(1000),
  path: boundedPathSchema,
  isRegex: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
  glob: z.string().min(1).max(500).optional(),
  context: z.number().optional(),
  outputMode: grepOutputModeSchema.optional(),
});

export const grepOutputSchema = z.object({
  query: z.string(),
  path: z.string(),
  matches: z.array(
    z.object({
      path: z.string(),
      lineNumber: z.number().int().min(1),
      column: z.number().int().min(1),
      line: z.string(),
      /** Lines just before and after the match, when context was asked for. */
      before: z.array(z.string()).optional(),
      after: z.array(z.string()).optional(),
    })
  ),
  /** outputMode "files": each matching file and its number of matching lines. */
  files: z
    .array(z.object({ path: z.string(), count: z.number().int().positive() }))
    .optional(),
  totalMatches: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
