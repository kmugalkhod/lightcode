import { z } from "zod";
import { MAX_TOOL_LIST_ENTRIES } from "../constants";
import { boundedPathSchema, integerRangeSchema } from "../common/base-schemas";

export const globSearchDescription =
  "Find workspace files by glob pattern. Use this when you know a filename shape, extension, or path pattern.";

export const globSearchInputSchema = z.object({
  pattern: z.string().min(1).max(1000),
  path: boundedPathSchema.optional().default("."),
  includeHidden: z.boolean().optional().default(false),
  includeDirectories: z.boolean().optional().default(false),
  maxResults: integerRangeSchema(1, MAX_TOOL_LIST_ENTRIES, "maxResults")
    .optional()
    .default(100),
});

export const globSearchProviderInputSchema = z.object({
  pattern: z.string().min(1).max(1000),
  path: boundedPathSchema.optional(),
  includeHidden: z.boolean().optional(),
});

export const globSearchOutputSchema = z.object({
  pattern: z.string(),
  path: z.string(),
  matches: z.array(
    z.object({
      path: z.string(),
      type: z.enum(["file", "directory", "symlink", "other"]),
      size: z.number().int().nonnegative().nullable(),
    }),
  ),
  totalMatches: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
