import { createLogger } from "@lightcode/shared";

const logger = createLogger("idle-timeout-fetch");

export const defaultHeadersTimeoutMs = 60_000;
export const defaultIdleTimeoutMs = 120_000;

/**
 * Thrown when a provider connection goes silent. Deliberately NOT an
 * AbortError: the chat error classifier must treat this as a retryable
 * network failure ("timed out" → network/retryable), not a user abort.
 */
export class HttpIdleTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpIdleTimeoutError";
  }
}

export interface IdleTimeoutFetchOptions {
  /** Max time waiting for response headers. 0 disables the check. */
  headersTimeoutMs?: number;
  /** Max time between response body bytes. 0 disables the check. */
  idleTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function parseTimeoutEnv(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "disabled" || trimmed === "off") {
    return 0;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

export function resolveIdleTimeoutsFromEnv(
  env: Record<string, string | undefined> = Bun.env,
): { headersTimeoutMs: number; idleTimeoutMs: number } {
  return {
    headersTimeoutMs:
      parseTimeoutEnv(env.LIGHTCODE_HTTP_HEADERS_TIMEOUT_MS) ??
      defaultHeadersTimeoutMs,
    idleTimeoutMs:
      parseTimeoutEnv(env.LIGHTCODE_HTTP_IDLE_TIMEOUT_MS) ?? defaultIdleTimeoutMs,
  };
}

/**
 * Wraps fetch with the two timeouts a hung provider stream can violate,
 * mirroring pi/undici's `headersTimeout`/`bodyTimeout`:
 *
 * - headers: time until the response headers arrive;
 * - idle: time between body bytes, reset on every chunk.
 *
 * Neither bounds total duration — a response streaming for an hour never
 * trips them, and providers keep silent periods alive with SSE comments
 * (OpenRouter ": OPENROUTER PROCESSING") or ping events (Anthropic). Only a
 * connection that stops producing bytes entirely is killed, surfacing an
 * HttpIdleTimeoutError so the retry layer restarts the turn instead of the
 * session hanging forever.
 */
export function createIdleTimeoutFetch({
  headersTimeoutMs = defaultHeadersTimeoutMs,
  idleTimeoutMs = defaultIdleTimeoutMs,
  fetchImpl = fetch,
}: IdleTimeoutFetchOptions = {}): typeof fetch {
  if (headersTimeoutMs <= 0 && idleTimeoutMs <= 0) {
    return fetchImpl;
  }

  const idleTimeoutFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const controller = new AbortController();
    const callerSignal = init?.signal ?? undefined;

    // Caller aborts (user stop, client disconnect) pass through with their
    // original reason so they still classify as "aborted", not as a timeout.
    const forwardCallerAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal) {
      if (callerSignal.aborted) {
        forwardCallerAbort();
      } else {
        callerSignal.addEventListener("abort", forwardCallerAbort, {
          once: true,
        });
      }
    }

    const abortWithTimeout = (error: HttpIdleTimeoutError) => {
      logger.warn("provider_connection_timed_out", { message: error.message });
      controller.abort(error);
    };

    let headersTimer: ReturnType<typeof setTimeout> | null = null;
    if (headersTimeoutMs > 0) {
      headersTimer = setTimeout(() => {
        abortWithTimeout(
          new HttpIdleTimeoutError(
            `Provider request timed out: no response headers within ${headersTimeoutMs}ms`,
          ),
        );
      }, headersTimeoutMs);
    }

    let response: Response;
    try {
      response = await fetchImpl(input, { ...init, signal: controller.signal });
    } finally {
      if (headersTimer) {
        clearTimeout(headersTimer);
      }
    }

    const body = response.body;
    if (idleTimeoutMs <= 0 || !body) {
      if (callerSignal) {
        callerSignal.removeEventListener("abort", forwardCallerAbort);
      }
      return response;
    }

    // Watchdog over the body: re-armed on every chunk. On expiry the wrapped
    // stream errors (so the SDK consumer sees a classified failure, not EOF)
    // and the underlying connection aborts (so the socket is released).
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const stopIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (callerSignal) {
        callerSignal.removeEventListener("abort", forwardCallerAbort);
      }
    };

    let rearm: () => void = () => {};
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      start(streamController) {
        const arm = () => {
          idleTimer = setTimeout(() => {
            const error = new HttpIdleTimeoutError(
              `Provider stream timed out: no bytes received for ${idleTimeoutMs}ms`,
            );
            stopIdleTimer();
            try {
              streamController.error(error);
            } catch {
              // Consumer already detached; aborting below is sufficient.
            }
            abortWithTimeout(error);
          }, idleTimeoutMs);
        };
        arm();
        rearm = () => {
          if (idleTimer) {
            clearTimeout(idleTimer);
          }
          arm();
        };
      },
      transform(chunk, streamController) {
        rearm();
        streamController.enqueue(chunk);
      },
      flush() {
        stopIdleTimer();
      },
      // No cancel hook in Bun's Transformer type (see sse-heartbeat.ts); a
      // cancelled reader is handled by the timer firing once into a detached
      // controller and aborting the already-cancelled fetch — both no-ops.
    });

    return new Response(body.pipeThrough(transform), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  return idleTimeoutFetch as typeof fetch;
}
