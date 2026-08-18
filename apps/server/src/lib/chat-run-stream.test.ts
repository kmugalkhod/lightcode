import { describe, expect, test } from "bun:test";
import {
  createOrderedRunEventRecorder,
  releaseOrderedRunEventRecorder,
} from "./chat-run-event-recorder";
import {
  createChatRun,
  getChatRun,
  listChatRunEvents,
  registerActiveRun,
  releaseActiveRun,
  updateChatRun,
} from "./chat-run-store";
import { createChatSession, deleteChatSession } from "./chat-store";
import {
  captureChatRunResponse,
  splitCompleteSseFrames,
} from "./chat-run-stream";

const encoder = new TextEncoder();

describe("chat run stream durability", () => {
  test("splits frames across arbitrary transport chunks", () => {
    let result = splitCompleteSseFrames(
      new Uint8Array(),
      encoder.encode("data: one\n\ndata: tw"),
    );
    expect(result.frames.map((frame) => new TextDecoder().decode(frame))).toEqual([
      "data: one\n\n",
    ]);
    result = splitCompleteSseFrames(result.pending, encoder.encode("o\r\n\r\n"));
    expect(result.frames.map((frame) => new TextDecoder().decode(frame))).toEqual([
      "data: two\r\n\r\n",
    ]);
    expect(result.pending).toHaveLength(0);
  });

  test(
    "continues draining and records run_finished after the client detaches",
    async () => {
      const session = await createChatSession({
        cwd: process.cwd(),
        title: "detached durable stream",
      });
      const created = await createChatRun({
        sessionId: session.id,
        clientTurnId: crypto.randomUUID(),
        expectedRevision: 0,
      });
      const runId = created.run.id;
      const runSignal = registerActiveRun(session.id, runId);
      const recorder = createOrderedRunEventRecorder({
        sessionId: session.id,
        runId,
      });
      let sourceController:
        | ReadableStreamDefaultController<Uint8Array>
        | undefined;
      let sourceCancelled = false;

      try {
        await updateChatRun({ runId, status: "running" });
        await recorder.record("run_started", { baseRevision: 0 });
        const source = new ReadableStream<Uint8Array>({
          start(controller) {
            sourceController = controller;
          },
          cancel() {
            sourceCancelled = true;
          },
        });
        const captured = captureChatRunResponse({
          response: new Response(source, {
            headers: { "content-type": "text/event-stream" },
          }),
          recorder,
          runSignal,
        });

        // Cancelling the HTTP follower must not cancel the provider/source.
        await captured.body?.cancel("client disconnected");
        sourceController?.enqueue(
          encoder.encode('data: {"type":"text-start","id":"t1"}\n'),
        );
        sourceController?.enqueue(encoder.encode("\n"));
        sourceController?.enqueue(
          encoder.encode('data: {"type":"text-delta","id":"t1","delta":"ok"}\n\n'),
        );
        sourceController?.close();

        const deadline = Date.now() + 3_000;
        let terminal = await getChatRun({ sessionId: session.id, runId });
        while (
          terminal?.status === "running" &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          terminal = await getChatRun({ sessionId: session.id, runId });
        }

        expect(sourceCancelled).toBe(false);
        expect(terminal?.status).toBe("completed");
        const events = await listChatRunEvents({
          sessionId: session.id,
          runId,
        });
        expect(events.events.map((event) => event.kind)).toEqual([
          "run_started",
          "sse_frame",
          "sse_frame",
          "run_finished",
        ]);
        expect(events.events.map((event) => event.cursor)).toEqual([0, 1, 2, 3]);
        expect(events.events.at(-1)?.payload).toMatchObject({
          status: "completed",
          finalRevision: 0,
        });
      } finally {
        releaseActiveRun(session.id, runId);
        releaseOrderedRunEventRecorder(recorder);
        await deleteChatSession(session.id).catch(() => undefined);
      }
    },
    10_000,
  );
});
