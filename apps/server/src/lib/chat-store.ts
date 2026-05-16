import type { MessageRole, Prisma } from "@lightcode/db/types";
import { safeValidateUIMessages, type UIMessage } from "ai";
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

function toStoredMessage(sessionId: string, sequence: number, message: UIMessage) {
  const normalizedMessage = normalizeMessageForStorage(message, sequence);
  const persistedMessageId = `${sequence}:${normalizedMessage.id}`;

  return {
    sessionId,
    messageId: persistedMessageId,
    role: roleByUiMessageRole[normalizedMessage.role],
    sequence,
    model: null,
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

export async function persistChatMessages({
  sessionId,
  messages,
}: {
  sessionId: string;
  messages: UIMessage[];
}) {
  const normalizedMessages = await normalizeAndValidateMessages(messages);
  const storedMessages = normalizedMessages.map((message, sequence) =>
    toStoredMessage(sessionId, sequence, message)
  );

  // Avoid transaction startup contention with pooled/serverless Postgres.
  // The final state is deterministic because we replace the full session history.
  await prisma.chatSession.upsert({
    where: { id: sessionId },
    update: {},
    create: { id: sessionId },
  });

  await prisma.chatMessage.deleteMany({
    where: { sessionId },
  });

  if (storedMessages.length > 0) {
    await prisma.chatMessage.createMany({
      data: storedMessages,
    });
  }
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
