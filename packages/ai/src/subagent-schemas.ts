import { z } from "zod";
import {
  codingAgentModeSchema,
  codingAgentToolNameSchema,
  type CodingAgentMode,
  type CodingAgentToolName,
} from "./coding-agent-modes";
import { sessionIdSchema } from "./chat-schemas";

export const defaultSubagentTaskMode = "plan" satisfies CodingAgentMode;

export const subagentProfileOrder = ["explore"] as const;
export type SubagentProfile = (typeof subagentProfileOrder)[number];
export const subagentProfileSchema = z.enum(subagentProfileOrder);
export const defaultSubagentProfile: SubagentProfile = "explore";

/**
 * Tool subsets a subagent may use, per profile (LC-049). Every profile must be
 * a strict reduction of the parent's tool surface — read-only tools only, so a
 * subagent can never expand permissions past its parent (LC-054).
 */
export const subagentProfileTools: Record<
  SubagentProfile,
  readonly CodingAgentToolName[]
> = {
  explore: [
    "list_files",
    "glob_search",
    "read_file",
    "grep",
    "git_status",
    "git_diff",
    "git_log",
    "git_show",
  ],
};

/**
 * Hard cap on the summary a subagent returns to its parent. The whole point of
 * delegating is that the parent context only pays for the conclusion, not the
 * exploration, so the cap is enforced structurally rather than by prompt alone.
 */
export const SUBAGENT_SUMMARY_TOKEN_CAP = 2_000;
const APPROX_CHARS_PER_TOKEN = 4;

export function capSubagentSummary(
  text: string,
  tokenCap: number = SUBAGENT_SUMMARY_TOKEN_CAP,
): { summary: string; truncated: boolean } {
  const maxChars = tokenCap * APPROX_CHARS_PER_TOKEN;
  const trimmed = text.trim();

  if (trimmed.length <= maxChars) {
    return { summary: trimmed, truncated: false };
  }

  return {
    summary: `${trimmed.slice(0, maxChars)}\n… (summary truncated at ~${tokenCap} tokens)`,
    truncated: true,
  };
}

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
