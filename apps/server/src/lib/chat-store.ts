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

export async function createChatSession(): Promise<{ id: string }> {
  const createdSession = await prisma.chatSession.create({
    data: { id: crypto.randomUUID() },
    select: { id: true },
  });

  return { id: createdSession.id };
}

export async function persistChatMessages({
  sessionId,
  messages,
  assistantModel = null,
}: {
  sessionId: string;
  messages: UIMessage[];
  assistantModel?: string | null;
}) {
  const normalizedMessages = await normalizeAndValidateMessages(messages);
  const sessionTitle = deriveSessionTitle(normalizedMessages);
  const storedMessages = normalizedMessages.map((message, sequence) =>
    toStoredMessage(sessionId, sequence, message, assistantModel)
  );

  // Avoid transaction startup contention with pooled/serverless Postgres.
  // The final state is deterministic because we replace the full session history.
  await prisma.chatSession.upsert({
    where: { id: sessionId },
    update: {},
    create: { id: sessionId, title: sessionTitle },
  });

  if (sessionTitle) {
    await prisma.chatSession.updateMany({
      where: {
        id: sessionId,
        title: null,
      },
      data: {
        title: sessionTitle,
      },
    });
  }

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
