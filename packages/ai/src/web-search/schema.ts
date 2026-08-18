import { z } from "zod";
import { integerRangeSchema } from "../common/base-schemas";

export const webSearchDescription =
  "Search the live web through the configured provider-native or local search backend and return citable sources.";

export const webSearchProviderSchema = z.enum(["auto", "brave", "tavily"]);

export const webSearchInputSchema = z.object({
  query: z.string().min(1).max(500),
  provider: webSearchProviderSchema.optional().default("auto"),
  maxResults: integerRangeSchema(1, 25, "maxResults")
    .optional()
    .default(3),
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
