import { z } from "zod";
import {
  defaultSubagentProfile,
  subagentProfileSchema,
  subagentTaskStatusSchema,
  SUBAGENT_SUMMARY_TOKEN_CAP,
} from "../subagent-schemas";

export const agentDescription =
  "Spawn a read-only subagent that explores the codebase in a fresh context and returns only a final summary " +
  `(max ~${SUBAGENT_SUMMARY_TOKEN_CAP} tokens). Use it for broad searches or multi-file questions where you need ` +
  "conclusions, not raw file contents. It cannot see this conversation or modify files, so make the prompt " +
  "self-contained: the question, relevant paths/symbols, and what the report must contain.";

export const agentInputSchema = z.object({
  description: z.string().min(1).max(100),
  prompt: z.string().min(1).max(50_000),
  profile: subagentProfileSchema.optional().default(defaultSubagentProfile),
  model: z.string().min(1).max(200).optional(),
});

export const agentProviderInputSchema = z.object({
  description: z
    .string()
    .min(1)
    .max(100)
    .describe("Short 3-5 word label for the task"),
  prompt: z.string().min(1).describe("Self-contained task for the subagent"),
  profile: subagentProfileSchema.optional(),
  model: z
    .string()
    .optional()
    .describe("Optional model id override; defaults to the session model"),
});

export const agentOutputSchema = z.object({
  taskId: z.string().nullable(),
  status: subagentTaskStatusSchema,
  summary: z.string(),
  truncated: z.boolean(),
});

export type AgentToolInput = z.infer<typeof agentInputSchema>;
export type AgentToolOutput = z.infer<typeof agentOutputSchema>;
