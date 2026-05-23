import { z } from "zod";
import { boundedPathSchema } from "../common/base-schemas";

export const editFileDescription =
  "Edit a file via literal search and replace. Use this for focused, small edits.";

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
});
