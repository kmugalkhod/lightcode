import { z } from "zod";
import {
  DEFAULT_TOOL_TEXT_OUTPUT_CHARS,
  MAX_TOOL_LIST_ENTRIES,
  MAX_TOOL_TEXT_OUTPUT_CHARS,
} from "../constants";
import { boundedPathSchema, integerRangeSchema } from "../common/base-schemas";

export const gitStatusDescription =
  "Return structured git status for the workspace without running an arbitrary shell command.";

export const gitDiffDescription =
  "Return a bounded git diff for workspace changes. Use this to inspect edits before summarizing.";

export const gitLogDescription =
  "Return recent git commits as structured metadata.";

export const gitShowDescription =
  "Show a commit or revision with bounded patch output.";

export const gitStatusInputSchema = z.object({
  maxEntries: integerRangeSchema(1, MAX_TOOL_LIST_ENTRIES, "maxEntries")
    .optional()
    .default(100),
});

export const gitStatusProviderInputSchema = z.object({});

export const gitDiffInputSchema = z.object({
  path: boundedPathSchema.optional(),
  staged: z.boolean().optional().default(false),
  statOnly: z.boolean().optional().default(false),
  maxChars: integerRangeSchema(200, MAX_TOOL_TEXT_OUTPUT_CHARS, "maxChars")
    .optional()
    .default(DEFAULT_TOOL_TEXT_OUTPUT_CHARS),
});

export const gitDiffProviderInputSchema = z.object({
  path: boundedPathSchema.optional(),
  staged: z.boolean().optional(),
  statOnly: z.boolean().optional(),
});

export const gitLogInputSchema = z.object({
  path: boundedPathSchema.optional(),
  maxCommits: integerRangeSchema(1, 50, "maxCommits").optional().default(10),
});

export const gitLogProviderInputSchema = gitLogInputSchema;

export const gitShowInputSchema = z.object({
  revision: z.string().min(1).max(240),
  path: boundedPathSchema.optional(),
  maxChars: integerRangeSchema(200, MAX_TOOL_TEXT_OUTPUT_CHARS, "maxChars")
    .optional()
    .default(DEFAULT_TOOL_TEXT_OUTPUT_CHARS),
});

export const gitShowProviderInputSchema = z.object({
  revision: z.string().min(1).max(240),
  path: boundedPathSchema.optional(),
});

export const gitCommandErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
});

export const gitStatusOutputSchema = z.object({
  ok: z.boolean(),
  cwd: z.string(),
  branch: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  entries: z.array(
    z.object({
      path: z.string(),
      indexStatus: z.string(),
      workingTreeStatus: z.string(),
      originalPath: z.string().nullable(),
    }),
  ),
  totalEntries: z.number().int().nonnegative(),
  truncated: z.boolean(),
  error: gitCommandErrorSchema.nullable(),
});

export const gitDiffOutputSchema = z.object({
  ok: z.boolean(),
  cwd: z.string(),
  path: z.string().nullable(),
  staged: z.boolean(),
  statOnly: z.boolean(),
  diff: z.string(),
  truncated: z.boolean(),
  error: gitCommandErrorSchema.nullable(),
});

export const gitLogOutputSchema = z.object({
  ok: z.boolean(),
  cwd: z.string(),
  path: z.string().nullable(),
  commits: z.array(
    z.object({
      hash: z.string(),
      shortHash: z.string(),
      authorName: z.string(),
      authorEmail: z.string(),
      date: z.string(),
      subject: z.string(),
    }),
  ),
  totalCommits: z.number().int().nonnegative(),
  truncated: z.boolean(),
  error: gitCommandErrorSchema.nullable(),
});

export const gitShowOutputSchema = z.object({
  ok: z.boolean(),
  cwd: z.string(),
  revision: z.string(),
  path: z.string().nullable(),
  content: z.string(),
  truncated: z.boolean(),
  error: gitCommandErrorSchema.nullable(),
});
