import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

function userMessage(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

function assistantMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
  } as UIMessage;
}

describe("persistChatMessages incremental writes", () => {
  test(
    "append writes only the tail, divergence rewrites, stale revision skips",
    async () => {
      const {
        clearPersistedMessageHashCache,
        createChatSession,
        deleteChatSession,
        persistChatMessages,
      } = await import("./chat-store");
      const { prisma } = await import("./prisma-client");

      const session = await createChatSession({
        cwd: process.cwd(),
        title: "incremental persist test",
      });
      const loadRows = () =>
        prisma.chatMessage.findMany({
          where: { sessionId: session.id },
          orderBy: { sequence: "asc" },
        });

      try {
        clearPersistedMessageHashCache();

        const first = await persistChatMessages({
          sessionId: session.id,
          messages: [userMessage("u1", "hello")],
        });
        expect(first.staleSkip).toBe(false);
        const rowsAfterFirst = await loadRows();
        expect(rowsAfterFirst).toHaveLength(1);

        // Append-only persist: the unchanged prefix row must survive with its
        // primary key intact — a full delete+rewrite would mint a new cuid.
        const second = await persistChatMessages({
          sessionId: session.id,
          messages: [userMessage("u1", "hello"), assistantMessage("a1", "hi")],
          expectedRevision: first.revision,
        });
        expect(second.staleSkip).toBe(false);
        const rowsAfterSecond = await loadRows();
        expect(rowsAfterSecond).toHaveLength(2);
        expect(rowsAfterSecond[0].id).toBe(rowsAfterFirst[0].id);

        // Divergence at index 0: everything from the divergent row on is
        // rewritten and the new payload wins.
        const third = await persistChatMessages({
          sessionId: session.id,
          messages: [
            userMessage("u1", "changed"),
            assistantMessage("a1", "hi"),
          ],
          expectedRevision: second.revision,
        });
        expect(third.staleSkip).toBe(false);
        const rowsAfterThird = await loadRows();
        expect(rowsAfterThird).toHaveLength(2);
        expect(rowsAfterThird[0].id).not.toBe(rowsAfterSecond[0].id);
        expect(JSON.stringify(rowsAfterThird[0].payload)).toContain("changed");

        // Stale expectedRevision: nothing written, cache dropped.
        const stale = await persistChatMessages({
          sessionId: session.id,
          messages: [userMessage("u1", "stale write")],
          expectedRevision: 0,
        });
        expect(stale.staleSkip).toBe(true);
        const rowsAfterStale = await loadRows();
        expect(rowsAfterStale).toHaveLength(2);
        expect(JSON.stringify(rowsAfterStale[0].payload)).toContain("changed");

        // After a stale skip the cache must not trust its prefix: the next
        // persist (fresh revision) still lands the correct final state.
        const fourth = await persistChatMessages({
          sessionId: session.id,
          messages: [userMessage("u1", "recovered")],
          expectedRevision: third.revision,
        });
        expect(fourth.staleSkip).toBe(false);
        const rowsAfterFourth = await loadRows();
        expect(rowsAfterFourth).toHaveLength(1);
        expect(JSON.stringify(rowsAfterFourth[0].payload)).toContain("recovered");
      } finally {
        await deleteChatSession(session.id);
      }
    },
    20_000,
  );
});
