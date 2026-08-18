import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

function userMessage(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

describe("chat run store", () => {
  test(
    "enforces turn idempotency and revisions while persisting ordered events",
    async () => {
      const {
        createChatSession,
        deleteChatSession,
        persistChatMessages,
      } = await import("./chat-store");
      const {
        appendChatRunEvent,
        createChatRun,
        getChatRunByClientTurnId,
        listChatRunEvents,
        SessionRevisionConflictError,
        updateChatRun,
      } = await import("./chat-run-store");
      const { replayChatRunResponse } = await import("./chat-run-stream");
      const session = await createChatSession({
        cwd: process.cwd(),
        title: "run store test",
      });

      try {
        const created = await createChatRun({
          sessionId: session.id,
          clientTurnId: "turn-admission-1",
          expectedRevision: 0,
        });
        expect(created.idempotent).toBe(false);

        const repeated = await createChatRun({
          sessionId: session.id,
          clientTurnId: "turn-admission-1",
          expectedRevision: 0,
        });
        expect(repeated.idempotent).toBe(true);
        expect(repeated.run.id).toBe(created.run.id);
        expect(
          (
            await getChatRunByClientTurnId({
              sessionId: session.id,
              clientTurnId: "turn-admission-1",
            })
          )?.id,
        ).toBe(created.run.id);

        await appendChatRunEvent({
          runId: created.run.id,
          cursor: 0,
          kind: "run_started",
          payload: { revision: 0 },
        });
        await appendChatRunEvent({
          runId: created.run.id,
          cursor: 1,
          kind: "sse_chunk",
          payload: { encoding: "base64", data: "b2s=" },
        });
        await updateChatRun({
          runId: created.run.id,
          status: "completed",
          finalRevision: 0,
        });

        const events = await listChatRunEvents({
          sessionId: session.id,
          runId: created.run.id,
        });
        expect(events.run.status).toBe("completed");
        expect(events.events.map((event) => event.cursor)).toEqual([0, 1]);
        expect(events.nextCursor).toBe(1);

        const persisted = await persistChatMessages({
          sessionId: session.id,
          messages: [userMessage("u1", "hello")],
          expectedRevision: 0,
        });
        expect(persisted.revision).toBe(1);
        await expect(
          createChatRun({
            sessionId: session.id,
            clientTurnId: "stale-admission",
            expectedRevision: 0,
          }),
        ).rejects.toBeInstanceOf(SessionRevisionConflictError);

        const failed = await createChatRun({
          sessionId: session.id,
          clientTurnId: "failed-before-stream",
          expectedRevision: 1,
        });
        await updateChatRun({
          runId: failed.run.id,
          status: "failed",
          finalRevision: 1,
          error: "Provider rejected the request.",
        });
        const replay = await replayChatRunResponse({
          sessionId: session.id,
          runId: failed.run.id,
        });
        expect(replay.status).toBe(502);
        expect(replay.headers.get("x-lightcode-run-id")).toBe(failed.run.id);
        expect(replay.headers.get("x-lightcode-revision")).toBe("1");
        expect(await replay.json()).toEqual({
          error: "Provider rejected the request.",
          code: "run_replay_unavailable",
          runId: failed.run.id,
          status: "failed",
          finalRevision: 1,
        });

        const cancelled = await createChatRun({
          sessionId: session.id,
          clientTurnId: "cancelled-before-stream",
          expectedRevision: 1,
        });
        await updateChatRun({
          runId: cancelled.run.id,
          status: "cancelled",
          finalRevision: 1,
        });
        const cancelledReplay = await replayChatRunResponse({
          sessionId: session.id,
          runId: cancelled.run.id,
        });
        expect(cancelledReplay.status).toBe(409);
        expect(await cancelledReplay.json()).toMatchObject({
          code: "run_replay_unavailable",
          runId: cancelled.run.id,
          status: "cancelled",
          finalRevision: 1,
        });
      } finally {
        await deleteChatSession(session.id).catch(() => undefined);
      }
    },
    20_000,
  );
});
