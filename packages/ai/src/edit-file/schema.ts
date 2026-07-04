import { z } from "zod";
import { boundedPathSchema } from "../common/base-schemas";

export const editFileDescription =
  "Edit a file via search and replace; copy the search text as shown by read_file " +
  "(whitespace and line endings are matched tolerantly). It must match exactly one " +
  "place — add surrounding context to disambiguate, or set replaceAll: true.";

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
