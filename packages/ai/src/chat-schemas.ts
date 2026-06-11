import { z } from "zod";
import { codingAgentModeSchema } from "./coding-agent-modes";
import { sessionContextStateSchema } from "./context/context-state";
import { permissionModeSchema } from "./permissions";

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

export const sessionContextResponseSchema = z.object({
  contextState: sessionContextStateSchema.nullable(),
  estimate: contextTokenEstimateSchema,
  contextWindow: z.number().int().positive(),
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

export const sessionExportJsonSchema = z.object({
  exportedAt: z.string().min(1),
  session: sessionMetadataSchema,
  messages: z.array(z.json()),
});
export type SessionExportJson = z.infer<typeof sessionExportJsonSchema>;
