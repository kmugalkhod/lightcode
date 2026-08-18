import type { ChatRunStatus, Prisma } from "@lightcode/db/types";
import type { SessionRunEvent } from "@lightcode/ai";
import { prisma } from "./prisma-client";
import { SessionNotFoundError } from "./chat-store";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

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
    return value.every(isJsonValue);
  }
  return (
    typeof value === "object" &&
    Object.values(value).every(isJsonValue)
  );
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  const serialized = JSON.parse(JSON.stringify(value));
  if (!isJsonValue(serialized) || serialized === null) {
    throw new Error("Unable to serialize run event payload.");
  }
  return serialized;
}

export class SessionRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Session revision conflict: expected ${expectedRevision}, current revision is ${actualRevision}.`,
    );
    this.name = "SessionRevisionConflictError";
  }
}

export class SessionRunConflictError extends Error {
  constructor(readonly activeRunId: string) {
    super(`Session already has an active run: ${activeRunId}`);
    this.name = "SessionRunConflictError";
  }
}

export interface StoredChatRun {
  id: string;
  sessionId: string;
  clientTurnId: string;
  status: ChatRunStatus;
  baseRevision: number;
  finalRevision: number | null;
  error: string | null;
}

function toStoredChatRun(run: StoredChatRun): StoredChatRun {
  return run;
}

export async function createChatRun({
  sessionId,
  clientTurnId,
  expectedRevision,
}: {
  sessionId: string;
  clientTurnId: string;
  expectedRevision: number;
}): Promise<{ run: StoredChatRun; idempotent: boolean }> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.chatRun.findUnique({
      where: {
        sessionId_clientTurnId: { sessionId, clientTurnId },
      },
      select: {
        id: true,
        sessionId: true,
        clientTurnId: true,
        status: true,
        baseRevision: true,
        finalRevision: true,
        error: true,
      },
    });
    if (existing) {
      return { run: toStoredChatRun(existing), idempotent: true };
    }

    const session = await tx.chatSession.findUnique({
      where: { id: sessionId },
      select: { revision: true },
    });
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }
    if (session.revision !== expectedRevision) {
      throw new SessionRevisionConflictError(
        expectedRevision,
        session.revision,
      );
    }

    const active = await tx.chatRun.findFirst({
      where: {
        sessionId,
        status: { in: ["pending", "running"] },
      },
      select: { id: true },
    });
    if (active) {
      throw new SessionRunConflictError(active.id);
    }

    const created = await tx.chatRun.create({
      data: {
        id: crypto.randomUUID(),
        sessionId,
        clientTurnId,
        baseRevision: expectedRevision,
        status: "pending",
      },
      select: {
        id: true,
        sessionId: true,
        clientTurnId: true,
        status: true,
        baseRevision: true,
        finalRevision: true,
        error: true,
      },
    });

    return { run: toStoredChatRun(created), idempotent: false };
  });
}

/** Marks runs orphaned by a previous server process as terminal on startup. */
export async function recoverInterruptedChatRuns(): Promise<number> {
  const result = await prisma.chatRun.updateMany({
    where: { status: { in: ["pending", "running"] } },
    data: {
      status: "failed",
      error: "Run interrupted by server restart; persisted events remain resumable.",
      finishedAt: new Date(),
    },
  });
  return result.count;
}

export async function updateChatRun({
  runId,
  status,
  finalRevision,
  error,
}: {
  runId: string;
  status: ChatRunStatus;
  finalRevision?: number | null;
  error?: string | null;
}): Promise<StoredChatRun> {
  const now = new Date();
  const run = await prisma.chatRun.update({
    where: { id: runId },
    data: {
      status,
      ...(status === "running" ? { startedAt: now } : {}),
      ...(["completed", "failed", "cancelled"].includes(status)
        ? { finishedAt: now }
        : {}),
      ...(finalRevision !== undefined ? { finalRevision } : {}),
      ...(error !== undefined ? { error } : {}),
    },
    select: {
      id: true,
      sessionId: true,
      clientTurnId: true,
      status: true,
      baseRevision: true,
      finalRevision: true,
      error: true,
    },
  });
  return toStoredChatRun(run);
}

export async function appendChatRunEvent({
  runId,
  cursor,
  kind,
  payload,
}: {
  runId: string;
  cursor: number;
  kind: string;
  payload: unknown;
}): Promise<void> {
  await prisma.chatRunEvent.create({
    data: {
      runId,
      cursor,
      kind,
      payload: toPrismaJson(payload),
    },
  });
}

export async function getChatRun({
  sessionId,
  runId,
}: {
  sessionId: string;
  runId: string;
}): Promise<StoredChatRun | null> {
  const run = await prisma.chatRun.findFirst({
    where: { id: runId, sessionId },
    select: {
      id: true,
      sessionId: true,
      clientTurnId: true,
      status: true,
      baseRevision: true,
      finalRevision: true,
      error: true,
    },
  });
  return run ? toStoredChatRun(run) : null;
}

/** Read-only idempotency lookup used before admitting a replacement request. */
export async function getChatRunByClientTurnId({
  sessionId,
  clientTurnId,
}: {
  sessionId: string;
  clientTurnId: string;
}): Promise<StoredChatRun | null> {
  const run = await prisma.chatRun.findUnique({
    where: {
      sessionId_clientTurnId: { sessionId, clientTurnId },
    },
    select: {
      id: true,
      sessionId: true,
      clientTurnId: true,
      status: true,
      baseRevision: true,
      finalRevision: true,
      error: true,
    },
  });
  return run ? toStoredChatRun(run) : null;
}

export async function listChatRunEvents({
  sessionId,
  runId,
  after = -1,
}: {
  sessionId: string;
  runId: string;
  after?: number;
}): Promise<{
  run: StoredChatRun;
  events: SessionRunEvent[];
  nextCursor: number;
}> {
  const run = await getChatRun({ sessionId, runId });
  if (!run) {
    throw new SessionNotFoundError(`run ${runId}`);
  }

  const events = await prisma.chatRunEvent.findMany({
    where: { runId, cursor: { gt: after } },
    orderBy: { cursor: "asc" },
    select: { cursor: true, kind: true, payload: true, createdAt: true },
  });

  return {
    run,
    events: events.map((event) => ({
      cursor: event.cursor,
      kind: event.kind,
      payload: event.payload as JsonValue,
      createdAt: event.createdAt.toISOString(),
    })),
    nextCursor: events.at(-1)?.cursor ?? after,
  };
}

interface ActiveRun {
  runId: string;
  controller: AbortController;
}

const activeRuns = new Map<string, ActiveRun>();

export function registerActiveRun(sessionId: string, runId: string): AbortSignal {
  const existing = activeRuns.get(sessionId);
  if (existing && existing.runId !== runId) {
    throw new SessionRunConflictError(existing.runId);
  }
  if (existing) {
    return existing.controller.signal;
  }

  const controller = new AbortController();
  activeRuns.set(sessionId, { runId, controller });
  return controller.signal;
}

export function releaseActiveRun(sessionId: string, runId: string): void {
  if (activeRuns.get(sessionId)?.runId === runId) {
    activeRuns.delete(sessionId);
  }
}

export function abortActiveRun(sessionId: string, runId: string): boolean {
  const active = activeRuns.get(sessionId);
  if (!active || active.runId !== runId) {
    return false;
  }
  active.controller.abort(new Error("Run aborted by user."));
  return true;
}

export function getActiveRunId(sessionId: string): string | null {
  return activeRuns.get(sessionId)?.runId ?? null;
}
