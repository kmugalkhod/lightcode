import {
  CheckpointConflictError,
  clearCheckpointRedo,
  redoLastTurn,
  undoCheckpointTurn,
} from "@lightcode/ai/runtime";
import type { Prisma } from "@lightcode/db/types";
import { safeValidateUIMessages, type UIMessage } from "ai";
import {
  loadChatSessionWithMessages,
  persistChatMessages,
} from "./chat-store";
import { prisma } from "./prisma-client";

interface RevertedTurnPayload {
  prefixMessageIds: string[];
  removedMessages: UIMessage[];
}

export class SessionHistoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionHistoryConflictError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function parseRevertedTurnPayload(
  value: unknown,
): Promise<RevertedTurnPayload> {
  if (
    !isRecord(value) ||
    !Array.isArray(value.prefixMessageIds) ||
    !value.prefixMessageIds.every((entry) => typeof entry === "string") ||
    !Array.isArray(value.removedMessages)
  ) {
    throw new Error("Stored redo payload is invalid.");
  }

  const validation = await safeValidateUIMessages({
    messages: value.removedMessages,
  });
  if (!validation.success) {
    throw new Error(`Stored redo messages are invalid: ${validation.error.message}`);
  }

  return {
    prefixMessageIds: value.prefixMessageIds,
    removedMessages: validation.data,
  };
}

function sameMessagePrefix(messages: UIMessage[], messageIds: string[]) {
  return (
    messages.length === messageIds.length &&
    messages.every((message, index) => message.id === messageIds[index])
  );
}

async function persistCanonicalMessages({
  sessionId,
  expectedRevision,
  messages,
}: {
  sessionId: string;
  expectedRevision: number;
  messages: UIMessage[];
}) {
  const loaded = await loadChatSessionWithMessages(sessionId);
  const result = await persistChatMessages({
    sessionId,
    messages,
    expectedRevision,
    assistantModel: loaded.session.model,
    cwd: loaded.session.cwd ?? undefined,
    mode: loaded.session.mode,
    permissionMode: loaded.session.permissionMode,
  });
  if (result.staleSkip) {
    throw new SessionHistoryConflictError(
      `Session changed while applying history action (revision ${result.revision}).`,
    );
  }
  return result.revision;
}

export async function clearSessionRedoBranch(sessionId: string): Promise<void> {
  await prisma.chatTurnRevert.updateMany({
    where: { sessionId, state: "undone" },
    data: { state: "discarded" },
  });
  await clearCheckpointRedo({ sessionId });
}

export async function undoSessionTurn(sessionId: string) {
  const loaded = await loadChatSessionWithMessages(sessionId);
  let userIndex = -1;
  for (let index = loaded.messages.length - 1; index >= 0; index -= 1) {
    if (loaded.messages[index]?.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) {
    return null;
  }

  const prefix = loaded.messages.slice(0, userIndex);
  const removedMessages = loaded.messages.slice(userIndex);
  const turnKey = loaded.messages[userIndex]!.id;
  const checkpoint = await undoCheckpointTurn({ sessionId, turnKey });

  let revision: number;
  try {
    revision = await persistCanonicalMessages({
      sessionId,
      expectedRevision: loaded.session.revision,
      messages: prefix,
    });
  } catch (error) {
    if (checkpoint) {
      await redoLastTurn({ sessionId, turnKey });
    }
    throw error;
  }

  try {
    await prisma.chatTurnRevert.create({
      data: {
        sessionId,
        turnKey,
        messages: toPrismaJson({
          prefixMessageIds: prefix.map((message) => message.id),
          removedMessages,
        } satisfies RevertedTurnPayload),
      },
    });
  } catch (error) {
    await persistCanonicalMessages({
      sessionId,
      expectedRevision: revision,
      messages: loaded.messages,
    });
    if (checkpoint) {
      await redoLastTurn({ sessionId, turnKey });
    }
    throw error;
  }

  return {
    turnKey,
    restoredFiles: checkpoint?.restoredFiles ?? [],
    messageCount: prefix.length,
    revision,
  };
}

export async function redoSessionTurn(sessionId: string) {
  const revert = await prisma.chatTurnRevert.findFirst({
    where: { sessionId, state: "undone" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, turnKey: true, messages: true },
  });
  if (!revert) {
    return null;
  }

  const loaded = await loadChatSessionWithMessages(sessionId);
  const payload = await parseRevertedTurnPayload(revert.messages);
  if (!sameMessagePrefix(loaded.messages, payload.prefixMessageIds)) {
    throw new SessionHistoryConflictError(
      "Redo refused because the conversation changed after undo.",
    );
  }

  const checkpoint = await redoLastTurn({
    sessionId,
    turnKey: revert.turnKey,
  });
  const restoredMessages = [...loaded.messages, ...payload.removedMessages];

  let revision: number;
  try {
    revision = await persistCanonicalMessages({
      sessionId,
      expectedRevision: loaded.session.revision,
      messages: restoredMessages,
    });
  } catch (error) {
    if (checkpoint) {
      await undoCheckpointTurn({ sessionId, turnKey: revert.turnKey });
    }
    throw error;
  }

  try {
    await prisma.chatTurnRevert.update({
      where: { id: revert.id },
      data: { state: "reapplied", reappliedAt: new Date() },
    });
  } catch (error) {
    await persistCanonicalMessages({
      sessionId,
      expectedRevision: revision,
      messages: loaded.messages,
    });
    if (checkpoint) {
      await undoCheckpointTurn({ sessionId, turnKey: revert.turnKey });
    }
    throw error;
  }

  return {
    turnKey: revert.turnKey,
    restoredFiles: checkpoint?.restoredFiles ?? [],
    messageCount: restoredMessages.length,
    revision,
  };
}

export { CheckpointConflictError };
