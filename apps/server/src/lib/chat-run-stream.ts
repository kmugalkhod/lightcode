import { createLogger, getErrorMessage } from "@lightcode/shared";
import {
  listChatRunEvents,
  releaseActiveRun,
  updateChatRun,
  type StoredChatRun,
} from "./chat-run-store";
import {
  releaseOrderedRunEventRecorder,
  type OrderedRunEventRecorder,
} from "./chat-run-event-recorder";
import { prisma } from "./prisma-client";

const logger = createLogger("chat-run-stream");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const terminalRunStatuses = new Set(["completed", "failed", "cancelled"]);
const defaultRunFollowPollMs = 75;

function cloneHeaders(headers: Headers) {
  const cloned = new Headers(headers);
  cloned.set("cache-control", "no-cache, no-transform");
  cloned.set("connection", "keep-alive");
  cloned.set("x-accel-buffering", "no");
  cloned.set("x-vercel-ai-ui-message-stream", "v1");
  return cloned;
}

async function loadSessionRevision(sessionId: string): Promise<number | null> {
  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { revision: true },
  });
  return session?.revision ?? null;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) {
    return right.slice();
  }
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

/** Extracts only complete SSE frames and keeps any trailing partial frame. */
export function splitCompleteSseFrames(
  pending: Uint8Array<ArrayBufferLike>,
  chunk: Uint8Array<ArrayBufferLike>,
): {
  frames: Uint8Array<ArrayBufferLike>[];
  pending: Uint8Array<ArrayBufferLike>;
} {
  const source = concatBytes(pending, chunk);
  const frames: Uint8Array<ArrayBufferLike>[] = [];
  let frameStart = 0;

  for (let index = 0; index < source.length - 1; index += 1) {
    let frameEnd = -1;
    if (source[index] === 0x0a && source[index + 1] === 0x0a) {
      frameEnd = index + 2;
    } else if (
      index + 3 < source.length &&
      source[index] === 0x0d &&
      source[index + 1] === 0x0a &&
      source[index + 2] === 0x0d &&
      source[index + 3] === 0x0a
    ) {
      frameEnd = index + 4;
    }

    if (frameEnd < 0) {
      continue;
    }

    frames.push(source.slice(frameStart, frameEnd));
    frameStart = frameEnd;
    index = frameEnd - 1;
  }

  return { frames, pending: source.slice(frameStart) };
}

function encodeFramePayload(frame: Uint8Array) {
  return {
    encoding: "base64" as const,
    data: Buffer.from(frame).toString("base64"),
  };
}

function decodeFramePayload(payload: unknown): Uint8Array | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const encoding = Reflect.get(payload, "encoding");
  const data = Reflect.get(payload, "data");
  if (encoding !== "base64" || typeof data !== "string") {
    return null;
  }
  return Uint8Array.from(Buffer.from(data, "base64"));
}

function readUiStreamError(frame: Uint8Array): string | null {
  const text = decoder.decode(frame);
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") {
      continue;
    }
    try {
      const value = JSON.parse(raw) as unknown;
      if (
        typeof value === "object" &&
        value !== null &&
        Reflect.get(value, "type") === "error"
      ) {
        const errorText = Reflect.get(value, "errorText");
        return typeof errorText === "string"
          ? errorText
          : "The provider stream ended with an error.";
      }
    } catch {
      // Non-JSON data fields are valid SSE; they simply are not UI errors.
    }
  }
  return null;
}

function cursorAcknowledgement(cursor: number): Uint8Array {
  // The acknowledgement follows its frame. If the connection drops between
  // them, reconnect replays one frame (safe) instead of skipping unseen data.
  return encoder.encode(`: lightcode-cursor=${cursor}\n\n`);
}

function enqueuePersistedFrame(
  controller: ReadableStreamDefaultController<Uint8Array>,
  frame: Uint8Array,
  cursor: number,
) {
  controller.enqueue(frame);
  controller.enqueue(cursorAcknowledgement(cursor));
}

function isTerminalRun(run: StoredChatRun): boolean {
  return terminalRunStatuses.has(run.status);
}

function waitForPoll(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      resolve(false);
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createRunFollowBody({
  sessionId,
  runId,
  after,
  requestSignal,
  pollIntervalMs = defaultRunFollowPollMs,
}: {
  sessionId: string;
  runId: string;
  after: number;
  requestSignal?: AbortSignal;
  pollIntervalMs?: number;
}): ReadableStream<Uint8Array> {
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        let cursor = after;
        try {
          while (!cancelled && !requestSignal?.aborted) {
            const snapshot = await listChatRunEvents({
              sessionId,
              runId,
              after: cursor,
            });
            for (const event of snapshot.events) {
              // Advance across semantic events as well as frames so polling is
              // incremental even when several tool lifecycle writes intervene.
              cursor = event.cursor;
              if (event.kind !== "sse_frame" && event.kind !== "sse_chunk") {
                continue;
              }
              const frame = decodeFramePayload(event.payload);
              if (frame) {
                enqueuePersistedFrame(controller, frame, event.cursor);
              }
            }

            if (isTerminalRun(snapshot.run)) {
              controller.close();
              return;
            }
            if (!(await waitForPoll(pollIntervalMs, requestSignal))) {
              controller.close();
              return;
            }
          }
          controller.close();
        } catch (error) {
          if (cancelled || requestSignal?.aborted) {
            try {
              controller.close();
            } catch {
              // The consumer already detached.
            }
            return;
          }
          controller.error(error);
        }
      })();
    },
    cancel() {
      // Detach this HTTP subscriber only. The source provider stream is owned
      // by the background pump and remains governed by the explicit run signal.
      cancelled = true;
    },
  });
}

const finalizations = new WeakMap<OrderedRunEventRecorder, Promise<void>>();

/** Persists run_finished and drains every earlier event before terminal state. */
export function finalizeChatRun({
  recorder,
  runSignal,
  error,
}: {
  recorder: OrderedRunEventRecorder;
  runSignal: AbortSignal;
  error?: unknown;
}): Promise<void> {
  const existing = finalizations.get(recorder);
  if (existing) {
    return existing;
  }

  const finalization = (async () => {
    const status = runSignal.aborted
      ? "cancelled"
      : error
        ? "failed"
        : "completed";
    const terminalError = runSignal.aborted ? runSignal.reason : error;
    const errorMessage = terminalError ? getErrorMessage(terminalError) : null;
    const finalRevision = await loadSessionRevision(recorder.sessionId);

    await recorder.record("run_finished", {
      status,
      error: errorMessage,
      finalRevision,
    });
    await recorder.drain();
    await updateChatRun({
      runId: recorder.runId,
      status,
      finalRevision,
      error: errorMessage,
    });
  })().finally(() => {
    releaseActiveRun(recorder.sessionId, recorder.runId);
    releaseOrderedRunEventRecorder(recorder);
  });

  finalizations.set(recorder, finalization);
  return finalization;
}

/**
 * Eagerly drains the provider UI stream into complete durable SSE frames. The
 * returned body merely follows those records, so cancelling it cannot cancel
 * provider generation or an in-flight tool.
 */
export function captureChatRunResponse({
  response,
  recorder,
  runSignal,
}: {
  response: Response;
  recorder: OrderedRunEventRecorder;
  runSignal: AbortSignal;
}): Response {
  if (!response.body) {
    void finalizeChatRun({
      recorder,
      runSignal,
      error: new Error("The provider response did not include a stream body."),
    });
    return response;
  }

  const reader = response.body.getReader();
  void (async () => {
    let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
    let streamError: unknown;
    let sawUiError = false;

    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        const split = splitCompleteSseFrames(pending, next.value);
        pending = split.pending;
        for (const frame of split.frames) {
          const frameError = readUiStreamError(frame);
          if (frameError) {
            sawUiError = true;
            streamError = new Error(frameError);
          }
          await recorder.record("sse_frame", encodeFramePayload(frame));
        }
      }

      if (pending.length > 0 && decoder.decode(pending).trim().length > 0) {
        logger.warn("chat_run_partial_sse_frame_discarded", {
          runId: recorder.runId,
          bytes: pending.length,
        });
      }
    } catch (error) {
      streamError = error;
      if (!runSignal.aborted && !sawUiError) {
        const errorFrame = encoder.encode(
          `data: ${JSON.stringify({
            type: "error",
            errorText: getErrorMessage(error),
          })}\n\n`,
        );
        try {
          await recorder.record("sse_frame", encodeFramePayload(errorFrame));
        } catch {
          // The finalizer below reports the original recorder failure.
        }
      }
    }

    try {
      await finalizeChatRun({ recorder, runSignal, error: streamError });
    } catch (error) {
      logger.error("chat_run_finalize_failed", {
        runId: recorder.runId,
        sessionId: recorder.sessionId,
        error: getErrorMessage(error),
      });
    }
  })();

  const headers = cloneHeaders(response.headers);
  headers.set("x-lightcode-run-id", recorder.runId);
  // Streaming responses do not predict a final revision. The client refreshes
  // canonical history once run_finished is observed.
  headers.delete("x-lightcode-revision");

  return new Response(
    createRunFollowBody({
      sessionId: recorder.sessionId,
      runId: recorder.runId,
      after: -1,
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  );
}

/** Replays a terminal run once, used for idempotent duplicate POSTs. */
export async function replayChatRunResponse({
  sessionId,
  runId,
  after = -1,
}: {
  sessionId: string;
  runId: string;
  after?: number;
}): Promise<Response> {
  const snapshot = await listChatRunEvents({ sessionId, runId, after });
  const frames = snapshot.events.flatMap(
    (event): Array<{ frame: Uint8Array; cursor: number }> => {
      if (event.kind !== "sse_frame" && event.kind !== "sse_chunk") {
        return [];
      }
      const frame = decodeFramePayload(event.payload);
      return frame ? [{ frame, cursor: event.cursor }] : [];
    },
  );

  const metadataHeaders: Record<string, string> = {
    "cache-control": "no-cache, no-transform",
    "x-lightcode-run-id": runId,
    ...(snapshot.run.finalRevision !== null
      ? { "x-lightcode-revision": String(snapshot.run.finalRevision) }
      : {}),
  };

  if (
    frames.length === 0 &&
    (snapshot.run.status === "failed" || snapshot.run.status === "cancelled")
  ) {
    const error =
      snapshot.run.error ??
      (snapshot.run.status === "cancelled"
        ? "The chat run was cancelled before it produced a response."
        : "The chat run failed before it produced a response.");
    return Response.json(
      {
        error,
        code: "run_replay_unavailable",
        runId,
        status: snapshot.run.status,
        finalRevision: snapshot.run.finalRevision,
      },
      {
        status: snapshot.run.status === "cancelled" ? 409 : 502,
        headers: metadataHeaders,
      },
    );
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const { frame, cursor } of frames) {
        enqueuePersistedFrame(controller, frame, cursor);
      }
      controller.close();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "x-vercel-ai-ui-message-stream": "v1",
      ...metadataHeaders,
    },
  });
}

/** Replays persisted frames after a cursor, then follows until run terminal. */
export async function resumeChatRunResponse({
  sessionId,
  runId,
  after = -1,
  requestSignal,
}: {
  sessionId: string;
  runId: string;
  after?: number;
  requestSignal?: AbortSignal;
}): Promise<Response> {
  const initial = await listChatRunEvents({ sessionId, runId, after });
  const hasRemainingFrame = initial.events.some(
    (event) => event.kind === "sse_frame" || event.kind === "sse_chunk",
  );
  if (isTerminalRun(initial.run) && !hasRemainingFrame) {
    return new Response(null, {
      status: 204,
      headers: {
        "x-lightcode-run-id": runId,
        ...(initial.run.finalRevision !== null
          ? { "x-lightcode-revision": String(initial.run.finalRevision) }
          : {}),
      },
    });
  }

  return new Response(
    createRunFollowBody({
      sessionId,
      runId,
      after,
      requestSignal,
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "connection": "keep-alive",
        "x-accel-buffering": "no",
        "x-vercel-ai-ui-message-stream": "v1",
        "x-lightcode-run-id": runId,
      },
    },
  );
}
