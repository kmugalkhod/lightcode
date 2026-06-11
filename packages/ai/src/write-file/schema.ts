import { z } from "zod";
import { boundedPathSchema } from "../common/base-schemas";

export const writeFileDescription =
  "Write complete file content to a path in the working directory. Use for creating or overwriting files.";

export const writeFileInputSchema = z.object({
  path: boundedPathSchema,
  content: z.string(),
  overwrite: z.boolean().optional().default(true),
});

export const writeFileProviderInputSchema = z.object({
  path: boundedPathSchema,
  content: z.string(),
});

export const writeFileOutputSchema = z.object({
  path: z.string(),
  created: z.boolean(),
  bytesWritten: z.number().int().nonnegative(),
  /** Unified diff against the previous content, for TUI rendering. */
  diff: z.string().optional(),
});
