import { z } from "zod";
import { MAX_TOOL_SEARCH_RESULTS } from "../constants";
import { integerRangeSchema } from "../common/base-schemas";
import { permissionModeSchema } from "../permissions";
import { codingAgentModeSchema, codingAgentToolNameSchema } from "../coding-agent-modes";

export const toolSearchDescription =
  "Search available coding-agent tools by name, capability, or permission requirement.";

export const toolSearchInputSchema = z.object({
  query: z.string().min(1).max(200),
  maxResults: integerRangeSchema(1, MAX_TOOL_SEARCH_RESULTS, "maxResults")
    .optional()
    .default(10),
});

export const toolSearchProviderInputSchema = z.object({
  query: z.string().min(1).max(200),
});

export const toolSearchOutputSchema = z.object({
  query: z.string(),
  results: z.array(
    z.object({
      name: codingAgentToolNameSchema,
      description: z.string(),
      permissionMode: permissionModeSchema,
      activeModes: z.array(codingAgentModeSchema),
      score: z.number(),
    }),
  ),
  totalResults: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
