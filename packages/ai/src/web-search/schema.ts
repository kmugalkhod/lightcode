import { z } from "zod";
import { MAX_TOOL_SEARCH_RESULTS } from "../constants";
import { integerRangeSchema } from "../common/base-schemas";

export const webSearchDescription =
  "Search the web through a configured search API provider. Requires network permission and a provider API key.";

export const webSearchProviderSchema = z.enum(["auto", "brave", "tavily"]);

export const webSearchInputSchema = z.object({
  query: z.string().min(1).max(500),
  provider: webSearchProviderSchema.optional().default("auto"),
  maxResults: integerRangeSchema(1, MAX_TOOL_SEARCH_RESULTS, "maxResults")
    .optional()
    .default(5),
});

export const webSearchProviderInputSchema = z.object({
  query: z.string().min(1).max(500),
});

export const webSearchErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const webSearchOutputSchema = z.object({
  ok: z.boolean(),
  query: z.string(),
  provider: z.string(),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      snippet: z.string(),
      source: z.string().nullable(),
    }),
  ),
  totalResults: z.number().int().nonnegative(),
  error: webSearchErrorSchema.nullable(),
});
