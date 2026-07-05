import { describe, expect, test } from "bun:test";
import {
  createIdleTimeoutFetch,
  HttpIdleTimeoutError,
  resolveIdleTimeoutsFromEnv,
} from "./idle-timeout-fetch";

const encoder = new TextEncoder();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createStreamingFetch() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let receivedSignal: AbortSignal | undefined;

  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    receivedSignal = init?.signal ?? undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    getSignal: () => receivedSignal,
  };
}

describe("createIdleTimeoutFetch", () => {
  test("passes healthy streams through untouched", async () => {
    const upstream = createStreamingFetch();
    const wrapped = createIdleTimeoutFetch({
      headersTimeoutMs: 200,
      idleTimeoutMs: 200,
      fetchImpl: upstream.fetchImpl,
    });

    const response = await wrapped("https://example.test");
    upstream.push("hello ");
    upstream.push("world");
    upstream.close();

    expect(await response.text()).toBe("hello world");
    expect(response.status).toBe(200);
  });

  test("long streams survive as long as bytes keep arriving", async () => {
    const upstream = createStreamingFetch();
    const wrapped = createIdleTimeoutFetch({
      headersTimeoutMs: 100,
      idleTimeoutMs: 60,
      fetchImpl: upstream.fetchImpl,
    });

    const response = await wrapped("https://example.test");
    const reader = response.body!.getReader();

    // Total duration (200ms) far exceeds the idle window (60ms), but chunks
    // keep the watchdog armed.
    for (let i = 0; i < 5; i += 1) {
      upstream.push(`chunk-${i}`);
      await sleep(40);
      const { value } = await reader.read();
      expect(value).toBeDefined();
    }
    upstream.close();
    expect((await reader.read()).done).toBe(true);
  });

  test("errors the stream when the body goes silent past the idle window", async () => {
    const upstream = createStreamingFetch();
    const wrapped = createIdleTimeoutFetch({
      headersTimeoutMs: 100,
      idleTimeoutMs: 50,
      fetchImpl: upstream.fetchImpl,
    });

    const response = await wrapped("https://example.test");
    const reader = response.body!.getReader();
    upstream.push("partial");
    await reader.read();

    // No further bytes: the read must reject instead of hanging forever.
    await expect(reader.read()).rejects.toBeInstanceOf(HttpIdleTimeoutError);
    // The underlying connection is released too.
    expect(upstream.getSignal()?.aborted).toBe(true);
  });

  test("aborts when response headers never arrive", async () => {
    const neverResolvingFetch = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason ?? new Error("aborted")),
        );
      })) as unknown as typeof fetch;

    const wrapped = createIdleTimeoutFetch({
      headersTimeoutMs: 40,
      idleTimeoutMs: 0,
      fetchImpl: neverResolvingFetch,
    });

    await expect(wrapped("https://example.test")).rejects.toBeInstanceOf(
      HttpIdleTimeoutError,
    );
  });

  test("caller aborts keep their own reason", async () => {
    const upstream = createStreamingFetch();
    const wrapped = createIdleTimeoutFetch({
      headersTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      fetchImpl: upstream.fetchImpl,
    });

    const callerController = new AbortController();
    const reason = new Error("user stopped the run");
    await wrapped("https://example.test", { signal: callerController.signal });
    callerController.abort(reason);

    expect(upstream.getSignal()?.aborted).toBe(true);
    expect(upstream.getSignal()?.reason).toBe(reason);
  });

  test("returns the raw fetch when both timeouts are disabled", () => {
    const upstream = createStreamingFetch();
    const wrapped = createIdleTimeoutFetch({
      headersTimeoutMs: 0,
      idleTimeoutMs: 0,
      fetchImpl: upstream.fetchImpl,
    });
    expect(wrapped).toBe(upstream.fetchImpl);
  });
});

describe("resolveIdleTimeoutsFromEnv", () => {
  test("uses defaults when env vars are absent", () => {
    expect(resolveIdleTimeoutsFromEnv({})).toEqual({
      headersTimeoutMs: 60_000,
      idleTimeoutMs: 120_000,
    });
  });

  test("parses numeric overrides and 'disabled'", () => {
    expect(
      resolveIdleTimeoutsFromEnv({
        LIGHTCODE_HTTP_HEADERS_TIMEOUT_MS: "30000",
        LIGHTCODE_HTTP_IDLE_TIMEOUT_MS: "disabled",
      }),
    ).toEqual({ headersTimeoutMs: 30_000, idleTimeoutMs: 0 });
  });

  test("falls back to defaults on invalid values", () => {
    expect(
      resolveIdleTimeoutsFromEnv({
        LIGHTCODE_HTTP_IDLE_TIMEOUT_MS: "not-a-number",
      }),
    ).toEqual({ headersTimeoutMs: 60_000, idleTimeoutMs: 120_000 });
  });
});
