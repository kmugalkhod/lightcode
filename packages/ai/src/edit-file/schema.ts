import { z } from "zod";
import { boundedPathSchema } from "../common/base-schemas";

export const editFileDescription =
  "Edit a file via search and replace. Always send both search (the current text, copied as shown by read_file; " +
  "whitespace and line endings are matched tolerantly) and replace (the new text). The search text must match " +
  "exactly one place — add surrounding lines to disambiguate, or set allMatches: true to change every occurrence.";

/**
 * Provider-facing grammar. The optional flag must not share a prefix with
 * `replace`: models given `replace` + `replaceAll` repeatedly emitted
 * `{path, replaceAll, search}` — the flag in place of the replacement text.
 */
export const editFileProviderInputSchema = z.object({
  path: boundedPathSchema,
  search: z.string().min(1),
  replace: z.string(),
  allMatches: z.boolean().optional().default(false),
});

export const editFileInputSchema = editFileProviderInputSchema.extend({
  /** Former name of allMatches, still honored for older sessions and approvals. */
  replaceAll: z.boolean().optional(),
});

export const editFileOutputSchema = z.object({
  path: z.string(),
  replacements: z.number().int().nonnegative(),
  bytesWritten: z.number().int().nonnegative(),
  /** Unified diff of the applied change, for TUI rendering. */
  diff: z.string().optional(),
});
