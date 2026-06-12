const encoder = new TextEncoder();
const heartbeatFrame = encoder.encode(": heartbeat\n\n");

export const defaultHeartbeatIntervalMs = 15_000;

function endsWithEventBoundary(chunk: Uint8Array) {
  // SSE events end with a blank line: \n\n or \r\n\r\n.
  const length = chunk.length;
  if (length >= 2 && chunk[length - 1] === 0x0a && chunk[length - 2] === 0x0a) {
    return true;
  }

  return (
    length >= 4 &&
    chunk[length - 1] === 0x0a &&
    chunk[length - 2] === 0x0d &&
    chunk[length - 3] === 0x0a &&
    chunk[length - 4] === 0x0d
  );
}

/**
 * Injects SSE comment heartbeats into an event stream that has been silent
 * for `intervalMs`. Reasoning models legitimately produce nothing visible for
 * minutes; without bytes on the wire, client stall watchdogs, corporate
 * proxies, and NAT idle timers all conclude the connection is dead.
 *
 * Comments (`: heartbeat`) are ignored by every SSE parser, so clients see
 * activity without any protocol change. A heartbeat is only injected when the
 * stream is at an event boundary — injecting mid-event would corrupt the
 * frame — which is also the steady state, since upstream writes whole events.
 */
export function withSseHeartbeat(
  response: Response,
  intervalMs: number = defaultHeartbeatIntervalMs,
): Response {
  const body = response.body;
  if (!body) {
    return response;
  }

  let atEventBoundary = true;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastChunkAt = Date.now();

  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      heartbeatTimer = setInterval(() => {
        if (!atEventBoundary || Date.now() - lastChunkAt < intervalMs) {
          return;
        }

        try {
          controller.enqueue(heartbeatFrame);
          lastChunkAt = Date.now();
        } catch {
          // Stream already closed/errored; the flush/cancel path cleans up.
          stopHeartbeat();
        }
      }, Math.min(intervalMs, 5_000));
    },
    transform(chunk, controller) {
      atEventBoundary = endsWithEventBoundary(chunk);
      lastChunkAt = Date.now();
      controller.enqueue(chunk);
    },
    flush() {
      stopHeartbeat();
    },
    // No cancel hook in Bun's Transformer type; when the reader cancels, the
    // next heartbeat enqueue throws and the catch above stops the timer.
  });

  const heartbeatBody = body.pipeThrough(transform);

  return new Response(heartbeatBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
