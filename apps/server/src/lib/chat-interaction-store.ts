import { Prisma } from "@lightcode/db/types";
import {
  chatInteractionListResponseSchema,
  chatInteractionListQuerySchema,
  chatInteractionResolveRequestSchema,
  chatInteractionSchema,
  chatInteractionUpsertRequestSchema,
  isTerminalChatInteractionStatus,
  sessionIdSchema,
  type ChatInteraction,
  type ChatInteractionKind,
  type ChatInteractionPendingSummary,
  type ChatInteractionResolveRequest,
  type ChatInteractionStatus,
  type ChatInteractionUpsertRequest,
} from "@lightcode/ai";
import { prisma } from "./prisma-client";

const chatInteractionSelect = {
  id: true,
  sessionId: true,
  toolCallId: true,
  kind: true,
  status: true,
  payload: true,
  response: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ChatInteractionSelect;

type ChatInteractionRecord = Prisma.ChatInteractionGetPayload<{
  select: typeof chatInteractionSelect;
}>;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export class ChatInteractionNotFoundError extends Error {
  constructor(toolCallId: string) {
    super(`Chat interaction not found: ${toolCallId}`);
    this.name = "ChatInteractionNotFoundError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }

  if (isRecord(value)) {
    return Object.values(value).every((entry) => isJsonValue(entry));
  }

  return false;
}

function isPrismaInputJsonValue(value: unknown): value is Prisma.InputJsonValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }

  if (isRecord(value)) {
    return Object.values(value).every((entry) => isJsonValue(entry));
  }

  return false;
}

function toPrismaJsonValue(value: unknown): Prisma.InputJsonValue {
  const serialized = JSON.parse(JSON.stringify(value));

  if (!isPrismaInputJsonValue(serialized)) {
    throw new Error("Unable to serialize chat interaction payload to JSON.");
  }

  return serialized;
}

function toPrismaNullableJsonValue(value: unknown) {
  if (value === null || value === undefined) {
    return Prisma.JsonNull;
  }

  return toPrismaJsonValue(value);
}

function toIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toChatInteraction(record: ChatInteractionRecord): ChatInteraction {
  return chatInteractionSchema.parse({
    id: record.id,
    sessionId: record.sessionId,
    toolCallId: record.toolCallId,
    kind: record.kind,
    status: record.status,
    payload: record.payload,
    response: record.response ?? null,
    resolvedAt: toIsoString(record.resolvedAt),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

async function findChatInteraction({
  sessionId,
  toolCallId,
}: {
  sessionId: string;
  toolCallId: string;
}) {
  return prisma.chatInteraction.findUnique({
    where: {
      sessionId_toolCallId: {
        sessionId,
        toolCallId,
      },
    },
    select: chatInteractionSelect,
  });
}

export async function upsertChatInteraction({
  sessionId,
  ...rawInput
}: {
  sessionId: string;
} & ChatInteractionUpsertRequest): Promise<ChatInteraction> {
  const validatedSessionId = sessionIdSchema.parse(sessionId);
  const input = chatInteractionUpsertRequestSchema.parse(rawInput);
  const existing = await findChatInteraction({
    sessionId: validatedSessionId,
    toolCallId: input.toolCallId,
  });

  if (existing && isTerminalChatInteractionStatus(existing.status)) {
    return toChatInteraction(existing);
  }

  const data = {
    kind: input.kind,
    status: "pending" as const,
    payload: toPrismaJsonValue(input.payload),
    response: Prisma.JsonNull,
    resolvedAt: null,
  };

  const record = existing
    ? await prisma.chatInteraction.update({
        where: { id: existing.id },
        data,
        select: chatInteractionSelect,
      })
    : await prisma.chatInteraction.create({
        data: {
          sessionId: validatedSessionId,
          toolCallId: input.toolCallId,
          ...data,
        },
        select: chatInteractionSelect,
      });

  return toChatInteraction(record);
}

export async function resolveChatInteraction({
  sessionId,
  toolCallId,
  ...rawInput
}: {
  sessionId: string;
  toolCallId: string;
} & ChatInteractionResolveRequest): Promise<ChatInteraction> {
  const validatedSessionId = sessionIdSchema.parse(sessionId);
  const input = chatInteractionResolveRequestSchema.parse(rawInput);
  const existing = await findChatInteraction({
    sessionId: validatedSessionId,
    toolCallId,
  });

  if (!existing) {
    throw new ChatInteractionNotFoundError(toolCallId);
  }

  if (isTerminalChatInteractionStatus(existing.status)) {
    return toChatInteraction(existing);
  }

  const record = await prisma.chatInteraction.update({
    where: { id: existing.id },
    data: {
      status: input.status,
      response: toPrismaNullableJsonValue(input.response),
      resolvedAt: new Date(),
    },
    select: chatInteractionSelect,
  });

  return toChatInteraction(record);
}

export async function listChatInteractions({
  sessionId,
  status,
  kind,
}: {
  sessionId: string;
  status?: ChatInteractionStatus;
  kind?: ChatInteractionKind;
}) {
  const query = chatInteractionListQuerySchema.parse({ status, kind });
  const records = await prisma.chatInteraction.findMany({
    where: {
      sessionId: sessionIdSchema.parse(sessionId),
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
    },
    orderBy: [{ createdAt: "asc" }],
    select: chatInteractionSelect,
  });

  return chatInteractionListResponseSchema.parse({
    interactions: records.map(toChatInteraction),
  });
}

export async function summarizePendingChatInteractions({
  staleAfterMs = 30 * 60 * 1000,
}: {
  staleAfterMs?: number;
} = {}): Promise<ChatInteractionPendingSummary> {
  const staleBefore = new Date(Date.now() - staleAfterMs);
  const [toolApprovals, userPrompts, stale] = await Promise.all([
    prisma.chatInteraction.count({
      where: { status: "pending", kind: "tool_approval" },
    }),
    prisma.chatInteraction.count({
      where: { status: "pending", kind: "user_prompt" },
    }),
    prisma.chatInteraction.count({
      where: { status: "pending", updatedAt: { lt: staleBefore } },
    }),
  ]);
  const total = toolApprovals + userPrompts;

  return {
    total,
    toolApprovals,
    userPrompts,
    stale,
    recoverable: total,
  };
}
