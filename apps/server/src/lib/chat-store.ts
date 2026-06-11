import type { MessageRole, Prisma } from "@lightcode/db/types";
import {
  codingAgentModeSchema,
  defaultCodingAgentMode,
  permissionModeSchema,
  type CodingAgentMode,
  type PermissionMode,
  type SessionExportJson,
  type SessionMetadata,
  type SessionSummary,
} from "@lightcode/ai";
import { safeValidateUIMessages, type UIMessage } from "ai";
import { incrementChatFailureCounter } from "./chat-observability";
import { prisma } from "./prisma-client";

const roleByUiMessageRole = {
  assistant: "assistant",
  system: "system",
  user: "user",
} satisfies Record<UIMessage["role"], MessageRole>;

export class SessionNotFoundError extends Error {
  constructor(sessionIdentifier: string) {
    super(`Session not found: ${sessionIdentifier}`);
    this.name = "SessionNotFoundError";
  }
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface ChatSessionMetadataRecord {
  id: string;
  title: string | null;
  cwd: string | null;
  mode: string;
  permissionMode: string | null;
  model: string | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
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

function getErrorCode(error: unknown): string | number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const code = error.code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

function toPrismaJsonValue(value: unknown): Prisma.InputJsonValue {
  const serialized = JSON.parse(JSON.stringify(value));

  if (!isPrismaInputJsonValue(serialized)) {
    throw new Error("Unable to serialize message payload to JSON.");
  }

  return serialized;
}

function toMessageId(value: string | undefined, fallback: string) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function normalizeMessageForStorage(message: UIMessage, sequence: number): UIMessage {
  const normalizedId = toMessageId(message.id, `message-${sequence}`);

  return {
    ...message,
    id: normalizedId,
  };
}

function normalizeSessionTitle(input: string): string {
  const normalized = input.replace(/\s+/g, " ").trim();

  if (normalized.length <= 80) {
    return normalized;
  }

  return `${normalized.slice(0, 77).trimEnd()}...`;
}

function normalizeSessionPreview(input: string): string {
  const normalized = input.replace(/\s+/g, " ").trim();

  if (normalized.length <= 120) {
    return normalized;
  }

  return `${normalized.slice(0, 117).trimEnd()}...`;
}

function isTextMessagePart(
  part: UIMessage["parts"][number],
): part is Extract<UIMessage["parts"][number], { type: "text"; text: string }> {
  return part.type === "text" && "text" in part && typeof part.text === "string";
}

function extractTextFromMessage(message: UIMessage): string {
  const textParts = message.parts
    .filter(isTextMessagePart)
    .map((part) => part.text)
    .filter((text) => text.length > 0);

  if (textParts.length > 0) {
    return textParts.join(" ");
  }

  return "";
}

function deriveSessionTitle(messages: UIMessage[]): string | null {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage) {
    return null;
  }

  const text = extractTextFromMessage(firstUserMessage).trim();
  if (!text) {
    return null;
  }

  return normalizeSessionTitle(text);
}

function coerceSessionMode(value: string | null | undefined): CodingAgentMode {
  const parsed = codingAgentModeSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultCodingAgentMode;
}

function coercePermissionMode(
  value: string | null | undefined,
): PermissionMode | null {
  const parsed = permissionModeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function toSessionMetadata(session: ChatSessionMetadataRecord): SessionMetadata {
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    mode: coerceSessionMode(session.mode),
    permissionMode: coercePermissionMode(session.permissionMode),
    model: session.model,
    revision: session.revision,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

function extractUserPromptPreviewFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  const candidate = {
    id: "preview-message",
    role: "user",
    parts: Array.isArray(payload.parts) ? payload.parts : [],
  } satisfies Pick<UIMessage, "id" | "role" | "parts">;
  const text = extractTextFromMessage(candidate as UIMessage).trim();

  return text ? normalizeSessionPreview(text) : null;
}

function toStoredMessage(
  sessionId: string,
  sequence: number,
  message: UIMessage,
  assistantModel: string | null
) {
  const normalizedMessage = normalizeMessageForStorage(message, sequence);
  const persistedMessageId = `${sequence}:${normalizedMessage.id}`;

  return {
    sessionId,
    messageId: persistedMessageId,
    role: roleByUiMessageRole[normalizedMessage.role],
    sequence,
    model: normalizedMessage.role === "assistant" ? assistantModel : null,
    payload: toPrismaJsonValue(normalizedMessage),
  } satisfies Prisma.ChatMessageUncheckedCreateInput;
}

async function normalizeAndValidateMessages(messages: UIMessage[]): Promise<UIMessage[]> {
  const normalizedMessages = messages.map((message, index) =>
    normalizeMessageForStorage(message, index)
  );
  const validationResult = await safeValidateUIMessages({
    messages: normalizedMessages,
  });

  if (!validationResult.success) {
    throw new Error(`Invalid chat messages payload: ${validationResult.error.message}`);
  }

  return validationResult.data;
}

function isPrismaUniqueConstraintError(error: unknown) {
  return getErrorCode(error) === "P2002";
}

function isPrismaTransactionStartTimeoutError(error: unknown) {
  return getErrorCode(error) === "P2028";
}

export async function createChatSession({
  cwd = process.cwd(),
  mode = defaultCodingAgentMode,
  permissionMode = null,
  model = null,
  title,
}: {
  cwd?: string;
  mode?: CodingAgentMode;
  permissionMode?: PermissionMode | null;
  model?: string | null;
  title?: string;
} = {}): Promise<{ id: string }> {
  const createdSession = await prisma.chatSession.create({
    data: {
      id: crypto.randomUUID(),
      cwd,
      mode,
      permissionMode,
      model,
      title: title ? normalizeSessionTitle(title) : null,
    },
    select: { id: true },
  });

  return { id: createdSession.id };
}

export interface PersistChatMessagesResult {
  revision: number;
  staleSkip: boolean;
}

export async function persistChatMessages({
  sessionId,
  messages,
  assistantModel = null,
  expectedRevision,
  cwd,
  mode,
  permissionMode,
}: {
  sessionId: string;
  messages: UIMessage[];
  assistantModel?: string | null;
  expectedRevision?: number;
  cwd?: string;
  mode?: CodingAgentMode;
  permissionMode?: PermissionMode | null;
}): Promise<PersistChatMessagesResult> {
  const normalizedMessages = await normalizeAndValidateMessages(messages);
  const sessionTitle = deriveSessionTitle(normalizedMessages);
  const storedMessages = normalizedMessages.map((message, sequence) =>
    toStoredMessage(sessionId, sequence, message, assistantModel)
  );

  const maxTransactionAttempts = 3;

  for (let attempt = 1; attempt <= maxTransactionAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const session = await tx.chatSession.upsert({
            where: { id: sessionId },
            update: {},
            create: {
              id: sessionId,
              title: sessionTitle,
              cwd: cwd ?? process.cwd(),
              mode: mode ?? defaultCodingAgentMode,
              permissionMode: permissionMode ?? null,
              model: assistantModel,
            },
            select: {
              id: true,
              title: true,
              revision: true,
            },
          });

          if (expectedRevision !== undefined && session.revision !== expectedRevision) {
            return {
              revision: session.revision,
              staleSkip: true,
            };
          }

          await tx.chatMessage.deleteMany({
            where: { sessionId },
          });

          if (storedMessages.length > 0) {
            await tx.chatMessage.createMany({
              data: storedMessages,
            });
          }

          const updatedSession = await tx.chatSession.update({
            where: { id: sessionId },
            data: {
              revision: {
                increment: 1,
              },
              ...(cwd
                ? {
                    cwd,
                  }
                : {}),
              ...(mode
                ? {
                    mode,
                  }
                : {}),
              ...(permissionMode !== undefined
                ? {
                    permissionMode,
                  }
                : {}),
              ...(assistantModel
                ? {
                    model: assistantModel,
                  }
                : {}),
              ...(sessionTitle && !session.title
                ? {
                    title: sessionTitle,
                  }
                : {}),
            },
            select: {
              revision: true,
            },
          });

          return {
            revision: updatedSession.revision,
            staleSkip: false,
          };
        },
        {
          maxWait: 10_000,
          timeout: 20_000,
        }
      );
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        incrementChatFailureCounter("db_unique_conflict", {
          sessionId,
        });
      }

      if (
        isPrismaTransactionStartTimeoutError(error) &&
        attempt < maxTransactionAttempts
      ) {
        await Bun.sleep(50 * attempt);
        continue;
      }

      throw error;
    }
  }

  throw new Error("Unreachable");
}

function hydratePersistedMessages(
  persistedMessages: Array<{
    sequence: number;
    role: MessageRole;
    payload: unknown;
  }>,
) {
  const normalizedCandidates = persistedMessages.map((persistedMessage) => {
    const payload =
      persistedMessage.payload && typeof persistedMessage.payload === "object" && !Array.isArray(persistedMessage.payload)
        ? persistedMessage.payload
        : {};
    const payloadRecord = isRecord(payload) ? payload : {};

    return {
      ...payloadRecord,
      id: toMessageId(
        typeof payloadRecord.id === "string" ? payloadRecord.id : undefined,
        `message-${persistedMessage.sequence}`
      ),
      role:
        typeof payloadRecord.role === "string"
          ? payloadRecord.role
          : persistedMessage.role,
    };
  });

  return normalizedCandidates;
}

async function validatePersistedMessages(
  persistedMessages: Array<{
    sequence: number;
    role: MessageRole;
    payload: unknown;
  }>,
) {
  if (persistedMessages.length === 0) {
    return [];
  }

  const validationResult = await safeValidateUIMessages({
    messages: hydratePersistedMessages(persistedMessages),
  });

  if (!validationResult.success) {
    throw new Error(`Persisted chat history failed validation: ${validationResult.error.message}`);
  }

  return validationResult.data;
}

export async function resolveChatSessionIdentifier(sessionIdentifier: string) {
  if (sessionIdentifier !== "latest") {
    return sessionIdentifier;
  }

  const latestSession = await prisma.chatSession.findFirst({
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true },
  });

  if (!latestSession) {
    throw new SessionNotFoundError(sessionIdentifier);
  }

  return latestSession.id;
}

export async function loadChatSessionWithMessages(sessionIdentifier: string): Promise<{
  session: SessionMetadata;
  messages: UIMessage[];
}> {
  const sessionId = await resolveChatSessionIdentifier(sessionIdentifier);
  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      title: true,
      cwd: true,
      mode: true,
      permissionMode: true,
      model: true,
      revision: true,
      createdAt: true,
      updatedAt: true,
      messages: {
        orderBy: { sequence: "asc" },
        select: {
          sequence: true,
          role: true,
          payload: true,
        },
      },
    },
  });

  if (!session) {
    throw new SessionNotFoundError(sessionIdentifier);
  }

  const { messages, ...sessionMetadata } = session;

  return {
    session: toSessionMetadata(sessionMetadata),
    messages: await validatePersistedMessages(messages),
  };
}

export async function loadChatMessages(sessionIdentifier: string): Promise<UIMessage[]> {
  return (await loadChatSessionWithMessages(sessionIdentifier)).messages;
}

export async function listChatSessions(limit = 50): Promise<SessionSummary[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const sessions = await prisma.chatSession.findMany({
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    take: safeLimit,
    select: {
      id: true,
      title: true,
      cwd: true,
      mode: true,
      permissionMode: true,
      model: true,
      revision: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          messages: true,
        },
      },
      messages: {
        where: { role: "user" },
        orderBy: { sequence: "desc" },
        take: 1,
        select: {
          payload: true,
        },
      },
    },
  });

  return sessions.map((session) => {
    const { _count, messages, ...metadata } = session;
    const latestUserPromptPreview =
      messages[0] ? extractUserPromptPreviewFromPayload(messages[0].payload) : null;

    return {
      ...toSessionMetadata(metadata),
      messageCount: _count.messages,
      latestUserPromptPreview,
    };
  });
}

/** User-initiated rename: pins the title so auto-titling never overwrites it. */
export async function renameChatSession(sessionId: string, title: string) {
  const normalizedTitle = normalizeSessionTitle(title);

  try {
    const session = await prisma.chatSession.update({
      where: { id: sessionId },
      data: { title: normalizedTitle, autoTitled: true },
      select: { id: true, title: true },
    });
    return { id: session.id, title: session.title };
  } catch (error) {
    if (getErrorCode(error) === "P2025") {
      throw new SessionNotFoundError(sessionId);
    }
    throw error;
  }
}

/** Updates session metadata: title and/or permission mode. */
export async function updateSessionMetadata(
  sessionId: string,
  updates: { title?: string; permissionMode?: PermissionMode },
) {
  try {
    const data: Prisma.ChatSessionUpdateInput = {};

    if (updates.title !== undefined) {
      data.title = normalizeSessionTitle(updates.title);
      data.autoTitled = true;
    }

    if (updates.permissionMode !== undefined) {
      data.permissionMode = updates.permissionMode;
    }

    const session = await prisma.chatSession.update({
      where: { id: sessionId },
      data,
      select: { id: true, title: true, permissionMode: true },
    });

    return {
      id: session.id,
      title: session.title,
      permissionMode: session.permissionMode,
    };
  } catch (error) {
    if (getErrorCode(error) === "P2025") {
      throw new SessionNotFoundError(sessionId);
    }
    throw error;
  }
}

/** Applies an LLM-generated title unless one was already pinned. */
export async function applyGeneratedSessionTitle(sessionId: string, title: string) {
  const normalizedTitle = normalizeSessionTitle(title);

  const updated = await prisma.chatSession.updateMany({
    where: { id: sessionId, autoTitled: false },
    data: { title: normalizedTitle, autoTitled: true },
  });

  return updated.count > 0;
}

/** Duplicates a session with its messages; interactions and context state regenerate. */
export async function forkChatSession(sessionId: string): Promise<{
  id: string;
  copiedMessages: number;
}> {
  return prisma.$transaction(async (tx) => {
    const session = await tx.chatSession.findUnique({
      where: { id: sessionId },
      select: {
        title: true,
        cwd: true,
        mode: true,
        permissionMode: true,
        model: true,
        messages: {
          orderBy: { sequence: "asc" },
          select: {
            messageId: true,
            role: true,
            model: true,
            sequence: true,
            payload: true,
          },
        },
      },
    });

    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    const forkId = crypto.randomUUID();
    const { messages, ...metadata } = session;

    await tx.chatSession.create({
      data: {
        id: forkId,
        ...metadata,
        title: metadata.title ? `${metadata.title} (fork)` : null,
        autoTitled: true,
        revision: 0,
      },
    });

    if (messages.length > 0) {
      await tx.chatMessage.createMany({
        data: messages.map((message) => ({
          ...message,
          payload: toPrismaJsonValue(message.payload),
          sessionId: forkId,
        })),
      });
    }

    return { id: forkId, copiedMessages: messages.length };
  });
}

export async function deleteChatSession(sessionId: string) {
  return prisma.$transaction(async (tx) => {
    const existingSession = await tx.chatSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        _count: {
          select: {
            messages: true,
          },
        },
      },
    });

    if (!existingSession) {
      throw new SessionNotFoundError(sessionId);
    }

    await tx.chatSession.delete({
      where: { id: sessionId },
    });

    return {
      id: existingSession.id,
      deleted: true,
      deletedMessages: existingSession._count.messages,
    };
  });
}

export async function exportChatSessionJson(
  sessionIdentifier: string,
): Promise<SessionExportJson> {
  const sessionWithMessages = await loadChatSessionWithMessages(sessionIdentifier);
  const messages = JSON.parse(
    JSON.stringify(sessionWithMessages.messages),
  ) as SessionExportJson["messages"];

  return {
    exportedAt: new Date().toISOString(),
    session: sessionWithMessages.session,
    messages,
  };
}
