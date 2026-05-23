import type { MessageRole, Prisma } from "@lightcode/db/types";
import { safeValidateUIMessages, type UIMessage } from "ai";
import { incrementChatFailureCounter } from "./chat-observability";
import { prisma } from "./prisma-client";

const roleByUiMessageRole = {
  assistant: "assistant",
  system: "system",
  user: "user",
} satisfies Record<UIMessage["role"], MessageRole>;

function toPrismaJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
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

function extractTextFromMessage(message: UIMessage): string {
  const parts = Array.isArray((message as { parts?: unknown }).parts)
    ? (message as { parts: unknown[] }).parts
    : [];
  const textParts = parts
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }

      const candidate = part as { type?: unknown; text?: unknown };
      if (candidate.type === "text" && typeof candidate.text === "string") {
        return candidate.text;
      }

      return "";
    })
    .filter((value) => value.length > 0);

  if (textParts.length > 0) {
    return textParts.join(" ");
  }

  const contentCandidate = (message as { content?: unknown }).content;
  return typeof contentCandidate === "string" ? contentCandidate : "";
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
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function isPrismaTransactionStartTimeoutError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2028"
  );
}

export async function createChatSession(): Promise<{ id: string }> {
  const createdSession = await prisma.chatSession.create({
    data: { id: crypto.randomUUID() },
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
}: {
  sessionId: string;
  messages: UIMessage[];
  assistantModel?: string | null;
  expectedRevision?: number;
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
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${sessionId}), hashtext(${`${sessionId}:chat`}))`;

          const session = await tx.chatSession.upsert({
            where: { id: sessionId },
            update: {},
            create: { id: sessionId, title: sessionTitle },
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

export async function loadChatMessages(sessionId: string): Promise<UIMessage[]> {
  const persistedMessages = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { sequence: "asc" },
    select: {
      sequence: true,
      role: true,
      messageId: true,
      payload: true,
    },
  });

  if (persistedMessages.length === 0) {
    return [];
  }

  const normalizedCandidates = persistedMessages.map((persistedMessage) => {
    const payload =
      persistedMessage.payload && typeof persistedMessage.payload === "object" && !Array.isArray(persistedMessage.payload)
        ? persistedMessage.payload
        : {};
    const payloadRecord = payload as Record<string, unknown>;

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

  const validationResult = await safeValidateUIMessages({
    messages: normalizedCandidates,
  });

  if (!validationResult.success) {
    throw new Error(`Persisted chat history failed validation: ${validationResult.error.message}`);
  }

  return validationResult.data;
}
