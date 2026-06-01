import { z } from "zod";
import { MAX_TOOL_SEARCH_RESULTS } from "../constants";
import { boundedPathSchema, integerRangeSchema } from "../common/base-schemas";

export const grepDescription =
  "Search project files for text or regex matches and return file path plus line information.";

export const grepInputSchema = z.object({
  query: z.string().min(1).max(1000),
  path: boundedPathSchema.optional().default("."),
  isRegex: z.boolean().optional().default(false),
  caseSensitive: z.boolean().optional().default(false),
  maxResults: integerRangeSchema(1, MAX_TOOL_SEARCH_RESULTS, "maxResults").optional().default(50),
});

export const grepProviderInputSchema = z.object({
  query: z.string().min(1).max(1000),
  path: boundedPathSchema,
  isRegex: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
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
    })
  ),
  totalMatches: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
