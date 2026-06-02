import { z } from "zod";
import {
  codingAgentModeSchema,
  codingAgentToolNameSchema,
  type CodingAgentMode,
} from "./coding-agent-modes";
import { sessionIdSchema } from "./chat-schemas";

export const defaultSubagentTaskMode = "plan" satisfies CodingAgentMode;

export const subagentTaskStatusOrder = [
  "pending",
  "running",
  "completed",
  "failed",
  "blocked_on_approval",
  "blocked_on_provider",
  "cancelled",
] as const;

export type SubagentTaskStatus = (typeof subagentTaskStatusOrder)[number];
export const subagentTaskStatusSchema = z.enum(subagentTaskStatusOrder);

export const subagentTaskOutputSchema = z.json();
export type SubagentTaskOutput = z.infer<typeof subagentTaskOutputSchema>;

export const subagentTaskCreateRequestSchema = z.object({
  parentSessionId: sessionIdSchema,
  prompt: z.string().min(1).max(50_000),
  mode: codingAgentModeSchema.default(defaultSubagentTaskMode),
  model: z.string().min(1).max(200).nullable().optional(),
  allowedTools: z.array(codingAgentToolNameSchema).default([]),
});
export type SubagentTaskCreateRequest = z.infer<
  typeof subagentTaskCreateRequestSchema
>;

export const subagentTaskSchema = subagentTaskCreateRequestSchema.extend({
  id: z.string().uuid(),
  status: subagentTaskStatusSchema,
  model: z.string().nullable(),
  output: subagentTaskOutputSchema.nullable(),
  error: z.string().nullable(),
  startedAt: z.string().min(1).nullable(),
  finishedAt: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type SubagentTask = z.infer<typeof subagentTaskSchema>;

export const subagentTaskListResponseSchema = z.object({
  tasks: z.array(subagentTaskSchema),
});
export type SubagentTaskListResponse = z.infer<
  typeof subagentTaskListResponseSchema
>;
