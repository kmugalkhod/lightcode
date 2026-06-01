import { z } from "zod";
import { MAX_TOOL_LIST_ENTRIES } from "../constants";
import { boundedPathSchema, integerRangeSchema } from "../common/base-schemas";

export const listFilesDescription =
  "List files and directories within the working directory. Use this before reading or editing unfamiliar locations.";

export const listFilesInputSchema = z.object({
  path: boundedPathSchema.optional().default("."),
  recursive: z.boolean().optional().default(false),
  includeHidden: z.boolean().optional().default(false),
  maxEntries: integerRangeSchema(1, MAX_TOOL_LIST_ENTRIES, "maxEntries").optional().default(100),
});

export const listFilesProviderInputSchema = z.object({
  path: boundedPathSchema,
  recursive: z.boolean().optional(),
  includeHidden: z.boolean().optional(),
});

export const listFilesOutputSchema = z.object({
  path: z.string(),
  entries: z.array(
    z.object({
      path: z.string(),
      type: z.enum(["file", "directory", "symlink", "other"]),
      size: z.number().int().nonnegative().nullable(),
    })
  ),
  totalEntries: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
