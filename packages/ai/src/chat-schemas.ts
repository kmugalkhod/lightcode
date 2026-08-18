import { z } from "zod";
import { codingAgentModeSchema } from "./coding-agent-modes";
import { sessionContextStateSchema } from "./context/context-state";
import { permissionModeSchema } from "./permissions";
import { permissionRulesSchema } from "./permissions";
import { codingAgentToolNameSchema } from "./coding-agent-modes";
import { sandboxConfigSchema } from "./sandbox/config";
import { providerWebSearchDecisionSchema } from "./web-search/config";

export const sessionIdSchema = z.string().uuid();
export const sessionIdentifierSchema = z.union([
  sessionIdSchema,
  z.literal("latest"),
]);

export const sessionPathParamsSchema = z.object({
  id: sessionIdentifierSchema,
});

export const concreteSessionPathParamsSchema = z.object({
  id: sessionIdSchema,
});

export const sessionCreateRequestSchema = z.object({
  cwd: z.string().min(1).max(4096).optional(),
  mode: codingAgentModeSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  title: z.string().min(1).max(120).optional(),
});

export const sessionCreateResponseSchema = z.object({
  id: sessionIdSchema,
});
export type SessionCreateResponse = z.infer<typeof sessionCreateResponseSchema>;

export const sessionUpdateRequestSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  permissionMode: permissionModeSchema.optional(),
});
export type SessionUpdateRequest = z.infer<typeof sessionUpdateRequestSchema>;

export const sessionForkResponseSchema = z.object({
  id: sessionIdSchema,
  copiedMessages: z.number().int().nonnegative(),
});
export type SessionForkResponse = z.infer<typeof sessionForkResponseSchema>;

export const sessionMetadataSchema = z.object({
  id: sessionIdSchema,
  title: z.string().nullable(),
  cwd: z.string().nullable(),
  mode: codingAgentModeSchema,
  permissionMode: permissionModeSchema.nullable(),
  model: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

export const sessionSummarySchema = sessionMetadataSchema.extend({
  messageCount: z.number().int().nonnegative(),
  latestUserPromptPreview: z.string().nullable(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const sessionListResponseSchema = z.object({
  sessions: z.array(sessionSummarySchema),
});
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

export const sessionMessagesResponseSchema = z.object({
  session: sessionMetadataSchema.optional(),
  messages: z.array(z.json()),
  contextState: sessionContextStateSchema.nullable().optional(),
});
export type SessionMessagesResponse = z.infer<typeof sessionMessagesResponseSchema>;

export const contextTokenEstimateSchema = z.object({
  tokens: z.number().nonnegative(),
  basis: z.enum(["usage_calibrated", "heuristic"]),
});

export const providerTurnTokenBreakdownSchema = z.object({
  systemTokens: z.number().int().nonnegative(),
  toolTokens: z.number().int().nonnegative(),
  messageTokens: z.number().int().nonnegative(),
  mediaTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  inputBudgetTokens: z.number().int().nonnegative(),
  messageBudgetTokens: z.number().int().nonnegative(),
  reservedOutputTokens: z.number().int().nonnegative(),
  contextWindow: z.number().int().positive(),
  remainingTokens: z.number().int().nonnegative(),
  compactedTokens: z.number().int().nonnegative(),
});

export const sessionContextResponseSchema = z.object({
  contextState: sessionContextStateSchema.nullable(),
  estimate: contextTokenEstimateSchema,
  contextWindow: z.number().int().positive(),
  breakdown: providerTurnTokenBreakdownSchema,
  withinBudget: z.boolean(),
});
export type SessionContextResponse = z.infer<typeof sessionContextResponseSchema>;

export const sessionCompactResponseSchema = z.object({
  contextState: sessionContextStateSchema,
  usedFallback: z.boolean(),
});
export type SessionCompactResponse = z.infer<typeof sessionCompactResponseSchema>;

export const sessionResumeResponseSchema = z.object({
  session: sessionMetadataSchema,
  messages: z.array(z.json()),
});
export type SessionResumeResponse = z.infer<typeof sessionResumeResponseSchema>;

export const sessionDeleteResponseSchema = z.object({
  id: sessionIdSchema,
  deleted: z.boolean(),
  deletedMessages: z.number().int().nonnegative(),
});
export type SessionDeleteResponse = z.infer<typeof sessionDeleteResponseSchema>;

/**
 * Delta admission contract for a server-authoritative chat session. The client
 * sends only the final UI message that changed; the server loads and merges the
 * canonical prefix from storage. `clientTurnId` is an idempotency key for an
 * identical admission attempt, while `expectedRevision` prevents stale clients
 * from rewriting a newer session.
 */
export const sessionTurnRequestSchema = z
  .object({
    clientTurnId: z.string().min(1).max(320),
    expectedRevision: z.number().int().nonnegative(),
    messageId: z.string().min(1).max(320),
    role: z.enum(["user", "assistant"]),
    parts: z.array(z.json()).min(1),
    metadata: z.json().optional(),
    trigger: z.string().min(1).max(80).optional(),
    mode: codingAgentModeSchema.optional(),
    permissionMode: permissionModeSchema.optional(),
    providerWebSearchDecision: providerWebSearchDecisionSchema.optional(),
    allowedTools: z.array(codingAgentToolNameSchema).optional(),
    permissionRules: permissionRulesSchema.optional(),
    sandbox: sandboxConfigSchema.optional(),
  })
  .strict();
export type SessionTurnRequest = z.infer<typeof sessionTurnRequestSchema>;

export const chatRunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type ChatRunStatus = z.infer<typeof chatRunStatusSchema>;

export const sessionRunPathParamsSchema = z.object({
  id: sessionIdentifierSchema,
  runId: z.string().uuid(),
});

export const sessionRunEventsQuerySchema = z.object({
  after: z.coerce.number().int().min(-1).default(-1),
});

export const sessionRunEventSchema = z.object({
  cursor: z.number().int().nonnegative(),
  kind: z.string().min(1).max(80),
  payload: z.json(),
  createdAt: z.string().min(1),
});
export type SessionRunEvent = z.infer<typeof sessionRunEventSchema>;

export const sessionRunEventsResponseSchema = z.object({
  runId: z.string().uuid(),
  status: chatRunStatusSchema,
  events: z.array(sessionRunEventSchema),
  nextCursor: z.number().int().min(-1),
});
export type SessionRunEventsResponse = z.infer<
  typeof sessionRunEventsResponseSchema
>;

export const sessionAbortRunResponseSchema = z.object({
  runId: z.string().uuid(),
  status: chatRunStatusSchema,
  aborted: z.boolean(),
});
export type SessionAbortRunResponse = z.infer<
  typeof sessionAbortRunResponseSchema
>;

export const sessionTurnHistoryActionResponseSchema = z.object({
  turnKey: z.string().min(1),
  restoredFiles: z.array(z.string()),
  messageCount: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
});
export type SessionTurnHistoryActionResponse = z.infer<
  typeof sessionTurnHistoryActionResponseSchema
>;

export const sessionExportJsonSchema = z.object({
  exportedAt: z.string().min(1),
  session: sessionMetadataSchema,
  messages: z.array(z.json()),
});
export type SessionExportJson = z.infer<typeof sessionExportJsonSchema>;
