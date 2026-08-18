import { describe, expect, test } from "bun:test";
import {
  createOrderedRunEventRecorder,
  getActiveRunEventRecorder,
  getOrderedRunEventRecorder,
  recordActiveRunToolEvent,
  recordRunEventById,
  recordRunToolEvent,
  releaseOrderedRunEventRecorder,
  RunEventRecorderConflictError,
  RunEventRecorderNotFoundError,
  type AppendRunEvent,
} from "./chat-run-event-recorder";

describe("ordered run event recorder", () => {
  test("allocates from zero and durably appends concurrent records in order", async () => {
    const appended: Parameters<AppendRunEvent>[0][] = [];
    let unblockFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      unblockFirst = resolve;
    });
    const appendEvent: AppendRunEvent = async (event) => {
      appended.push(event);
      if (event.cursor === 0) {
        await firstBlocked;
      }
    };
    const recorder = createOrderedRunEventRecorder({
      sessionId: "ordered-session",
      runId: "ordered-run",
      appendEvent,
    });

    try {
      const started = recorder.record("run_started", { revision: 3 });
      const frame = recorder.record({
        kind: "sse_frame",
        payload: { data: "first" },
      });
      const finished = recorder.record("run_finished", {
        status: "completed",
      });

      await Promise.resolve();
      expect(appended.map((event) => event.cursor)).toEqual([0]);
      expect(recorder.nextCursor).toBe(3);

      unblockFirst?.();
      expect(await Promise.all([started, frame, finished])).toEqual([0, 1, 2]);
      await recorder.drain();
      expect(appended.map((event) => [event.cursor, event.kind])).toEqual([
        [0, "run_started"],
        [1, "sse_frame"],
        [2, "run_finished"],
      ]);
    } finally {
      releaseOrderedRunEventRecorder(recorder);
    }
  });

  test("propagates an append failure through later records and drain", async () => {
    const failure = new Error("database unavailable");
    const attempted: number[] = [];
    const recorder = createOrderedRunEventRecorder({
      sessionId: "failure-session",
      runId: "failure-run",
      appendEvent: async (event) => {
        attempted.push(event.cursor);
        throw failure;
      },
    });

    try {
      const first = recorder.record("run_started", {});
      const second = recorder.record("sse_frame", { data: "not-written" });

      await expect(first).rejects.toBe(failure);
      await expect(second).rejects.toBe(failure);
      await expect(recorder.drain()).rejects.toBe(failure);
      expect(attempted).toEqual([0]);
      expect(recorder.nextCursor).toBe(2);
    } finally {
      releaseOrderedRunEventRecorder(recorder);
    }
  });

  test("registers one recorder per run and active session with identity-safe release", () => {
    const appendEvent: AppendRunEvent = async () => undefined;
    const first = createOrderedRunEventRecorder({
      sessionId: "registry-session",
      runId: "registry-run",
      appendEvent,
    });

    expect(getOrderedRunEventRecorder(first.runId)).toBe(first);
    expect(getActiveRunEventRecorder(first.sessionId)).toBe(first);
    expect(() =>
      createOrderedRunEventRecorder({
        sessionId: "another-session",
        runId: first.runId,
        appendEvent,
      }),
    ).toThrow(RunEventRecorderConflictError);
    expect(() =>
      createOrderedRunEventRecorder({
        sessionId: first.sessionId,
        runId: "another-run",
        appendEvent,
      }),
    ).toThrow(RunEventRecorderConflictError);

    expect(releaseOrderedRunEventRecorder(first)).toBe(true);
    const replacement = createOrderedRunEventRecorder({
      sessionId: first.sessionId,
      runId: first.runId,
      appendEvent,
    });
    try {
      expect(releaseOrderedRunEventRecorder(first)).toBe(false);
      expect(getOrderedRunEventRecorder(first.runId)).toBe(replacement);
      expect(getActiveRunEventRecorder(first.sessionId)).toBe(replacement);
    } finally {
      releaseOrderedRunEventRecorder(replacement);
    }
  });

  test("records general and semantic tool events through registry helpers", async () => {
    const appended: Parameters<AppendRunEvent>[0][] = [];
    const recorder = createOrderedRunEventRecorder({
      sessionId: "helper-session",
      runId: "helper-run",
      startCursor: 4,
      appendEvent: async (event) => {
        appended.push(event);
      },
    });

    try {
      await recordRunEventById(recorder.runId, {
        kind: "sse_frame",
        payload: { data: "frame" },
      });
      await recordRunToolEvent(recorder.runId, {
        kind: "tool_call_started",
        toolCallId: "call-1",
        toolName: "bash",
        input: { command: "pwd" },
      });
      await recordActiveRunToolEvent(recorder.sessionId, {
        kind: "tool_call_result",
        toolCallId: "call-1",
        toolName: "bash",
        output: { stdout: "/workspace" },
      });
      await recorder.drain();

      expect(appended.map((event) => event.cursor)).toEqual([4, 5, 6]);
      expect(appended[1]).toMatchObject({
        kind: "tool_call_started",
        payload: {
          toolCallId: "call-1",
          toolName: "bash",
          input: { command: "pwd" },
        },
      });
      expect(appended[2]).toMatchObject({
        kind: "tool_call_result",
        payload: {
          toolCallId: "call-1",
          toolName: "bash",
          output: { stdout: "/workspace" },
        },
      });
    } finally {
      releaseOrderedRunEventRecorder(recorder);
    }

    await expect(
      recordRunToolEvent("missing-run", {
        kind: "tool_call_error",
        toolCallId: "missing",
        toolName: "bash",
        error: "not found",
      }),
    ).rejects.toBeInstanceOf(RunEventRecorderNotFoundError);
  });
});
