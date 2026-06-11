import {
  sessionContextStateSchema,
  type ContextStateTier,
  type SessionContextState,
} from "@lightcode/ai";
import { prisma } from "./prisma-client";

interface SessionContextStateRecord {
  sessionId: string;
  summary: string;
  anchorMessageId: string;
  coveredMessageCount: number;
  estimatedTokens: number;
  tier: string;
  model: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toSessionContextState(
  record: SessionContextStateRecord,
): SessionContextState {
  return sessionContextStateSchema.parse({
    sessionId: record.sessionId,
    summary: record.summary,
    anchorMessageId: record.anchorMessageId,
    coveredMessageCount: record.coveredMessageCount,
    estimatedTokens: record.estimatedTokens,
    tier: record.tier,
    model: record.model,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

export async function getSessionContextState(
  sessionId: string,
): Promise<SessionContextState | null> {
  const record = await prisma.sessionContextState.findUnique({
    where: { sessionId },
  });

  return record ? toSessionContextState(record) : null;
}

export async function upsertSessionContextState({
  sessionId,
  summary,
  anchorMessageId,
  coveredMessageCount,
  estimatedTokens,
  tier,
  model = null,
}: {
  sessionId: string;
  summary: string;
  anchorMessageId: string;
  coveredMessageCount: number;
  estimatedTokens: number;
  tier: ContextStateTier;
  model?: string | null;
}): Promise<SessionContextState> {
  const data = {
    summary,
    anchorMessageId,
    coveredMessageCount,
    estimatedTokens,
    tier,
    model,
  };

  const record = await prisma.sessionContextState.upsert({
    where: { sessionId },
    update: data,
    create: { sessionId, ...data },
  });

  return toSessionContextState(record);
}

export async function clearSessionContextState(sessionId: string): Promise<void> {
  await prisma.sessionContextState.deleteMany({
    where: { sessionId },
  });
}
