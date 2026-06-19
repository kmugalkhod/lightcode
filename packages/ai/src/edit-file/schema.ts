import { z } from "zod";
import { boundedPathSchema } from "../common/base-schemas";

export const editFileDescription =
  "Edit a file via search and replace. Use this for focused, small edits. " +
  "Line endings (CRLF/LF) and surrounding whitespace are matched tolerantly, so " +
  "copy the lines as shown by read_file. The search text must match exactly one " +
  "place — include enough surrounding context to make it unique, or set " +
  "replaceAll: true to change every occurrence.";

export const editFileInputSchema = z.object({
  path: boundedPathSchema,
  search: z.string().min(1),
  replace: z.string(),
  replaceAll: z.boolean().optional().default(false),
});

export const editFileProviderInputSchema = editFileInputSchema;

export const editFileOutputSchema = z.object({
  path: z.string(),
  replacements: z.number().int().nonnegative(),
  bytesWritten: z.number().int().nonnegative(),
  /** Unified diff of the applied change, for TUI rendering. */
  diff: z.string().optional(),
});
