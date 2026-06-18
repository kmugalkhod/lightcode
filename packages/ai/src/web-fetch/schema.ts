import { z } from "zod";
import {
  DEFAULT_TOOL_TEXT_OUTPUT_CHARS,
  MAX_TOOL_TEXT_OUTPUT_CHARS,
} from "../constants";
import { integerRangeSchema } from "../common/base-schemas";

export const webFetchDescription =
  "Fetch a URL and return normalized, bounded text with source metadata. Keep maxChars modest and request more only if the answer wasn't in the returned text. Requires network permission.";

export const webFetchInputSchema = z.object({
  url: z.string().url().max(4096),
  maxChars: integerRangeSchema(200, MAX_TOOL_TEXT_OUTPUT_CHARS, "maxChars")
    .optional()
    .default(DEFAULT_TOOL_TEXT_OUTPUT_CHARS),
  timeoutMs: integerRangeSchema(1_000, 30_000, "timeoutMs")
    .optional()
    .default(10_000),
});

export const webFetchProviderInputSchema = z.object({
  url: z.string().url().max(4096),
});

export const webFetchErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const webFetchOutputSchema = z.object({
  ok: z.boolean(),
  url: z.string(),
  finalUrl: z.string().nullable(),
  status: z.number().int().nullable(),
  statusText: z.string().nullable(),
  contentType: z.string().nullable(),
  title: z.string().nullable(),
  text: z.string(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
  error: webFetchErrorSchema.nullable(),
});
