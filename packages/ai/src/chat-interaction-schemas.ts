import { z } from "zod";
import { codingAgentToolNameSchema } from "./coding-agent-modes";
import { sessionIdSchema, sessionIdentifierSchema } from "./chat-schemas";
import { permissionDecisionSchema } from "./permissions";
import {
  requestUserInputToolInputSchema,
  requestUserInputToolOutputSchema,
} from "./request-user-input/schema";

export const chatInteractionKindOrder = [
  "tool_approval",
  "user_prompt",
] as const;
export type ChatInteractionKind = (typeof chatInteractionKindOrder)[number];
export const chatInteractionKindSchema = z.enum(chatInteractionKindOrder);

export const chatInteractionStatusOrder = [
  "pending",
  "approved",
  "denied",
  "answered",
  "superseded",
] as const;
export type ChatInteractionStatus =
  (typeof chatInteractionStatusOrder)[number];
export const chatInteractionStatusSchema = z.enum(chatInteractionStatusOrder);

export const chatInteractionToolCallIdSchema = z
  .string()
  .min(1)
  .max(240);

export const chatInteractionToolApprovalPayloadSchema = z.object({
  toolName: codingAgentToolNameSchema,
  input: z.json(),
  summary: z.string().min(1).max(4_000),
  permissionDecision: permissionDecisionSchema,
  cwd: z.string().min(1).max(4096),
});
export type ChatInteractionToolApprovalPayload = z.infer<
  typeof chatInteractionToolApprovalPayloadSchema
>;

export const chatInteractionUserPromptPayloadSchema =
  requestUserInputToolInputSchema;
export type ChatInteractionUserPromptPayload = z.infer<
  typeof chatInteractionUserPromptPayloadSchema
>;

export const chatInteractionPayloadSchema = z.union([
  chatInteractionToolApprovalPayloadSchema,
  chatInteractionUserPromptPayloadSchema,
]);

export const chatInteractionSchema = z.object({
  id: z.string().min(1),
  sessionId: sessionIdSchema,
  toolCallId: chatInteractionToolCallIdSchema,
  kind: chatInteractionKindSchema,
  status: chatInteractionStatusSchema,
  payload: z.json(),
  response: z.json().nullable(),
  resolvedAt: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type ChatInteraction = z.infer<typeof chatInteractionSchema>;

export const chatInteractionUpsertRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tool_approval"),
    toolCallId: chatInteractionToolCallIdSchema,
    payload: chatInteractionToolApprovalPayloadSchema,
  }),
  z.object({
    kind: z.literal("user_prompt"),
    toolCallId: chatInteractionToolCallIdSchema,
    payload: chatInteractionUserPromptPayloadSchema,
  }),
]);
export type ChatInteractionUpsertRequest = z.infer<
  typeof chatInteractionUpsertRequestSchema
>;

const nonPendingInteractionStatusSchema = chatInteractionStatusSchema.exclude([
  "pending",
]);

export const chatInteractionResolveRequestSchema = z.union([
  z.object({
    status: z.literal("answered"),
    response: requestUserInputToolOutputSchema,
  }),
  z.object({
    status: z.enum(["approved", "denied", "superseded"]),
    response: z.json().optional(),
  }),
]);
export type ChatInteractionResolveRequest = z.infer<
  typeof chatInteractionResolveRequestSchema
>;

export const chatInteractionListQuerySchema = z.object({
  status: chatInteractionStatusSchema.optional(),
  kind: chatInteractionKindSchema.optional(),
});

export const sessionInteractionPathParamsSchema = z.object({
  id: sessionIdentifierSchema,
});

export const concreteSessionInteractionPathParamsSchema = z.object({
  id: sessionIdentifierSchema,
  toolCallId: chatInteractionToolCallIdSchema,
});

export const chatInteractionListResponseSchema = z.object({
  interactions: z.array(chatInteractionSchema),
});
export type ChatInteractionListResponse = z.infer<
  typeof chatInteractionListResponseSchema
>;

export const chatInteractionPendingSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  toolApprovals: z.number().int().nonnegative(),
  userPrompts: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  recoverable: z.number().int().nonnegative(),
});
export type ChatInteractionPendingSummary = z.infer<
  typeof chatInteractionPendingSummarySchema
>;

export function isTerminalChatInteractionStatus(
  status: ChatInteractionStatus,
) {
  return nonPendingInteractionStatusSchema.safeParse(status).success;
}
