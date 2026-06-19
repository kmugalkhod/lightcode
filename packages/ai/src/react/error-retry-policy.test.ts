import { describe, expect, test } from "bun:test";
import { decideErrorRetry } from "./use-coding-session-chat";

describe("decideErrorRetry", () => {
  test("network errors back off exponentially up to the cap", () => {
    expect(decideErrorRetry({ attempt: 1, kind: "network", elapsedMs: 0, maxErrorRetries: 8 })).toEqual({
      retry: true,
      delayMs: 1_000,
    });
    expect(decideErrorRetry({ attempt: 2, kind: "network", elapsedMs: 0, maxErrorRetries: 8 }).delayMs).toBe(2_000);
    expect(decideErrorRetry({ attempt: 3, kind: "network", elapsedMs: 0, maxErrorRetries: 8 }).delayMs).toBe(4_000);
  });

  test("backoff is capped at the max delay", () => {
    expect(decideErrorRetry({ attempt: 10, kind: "network", elapsedMs: 0, maxErrorRetries: 20 }).delayMs).toBe(8_000);
  });

  test("network retries keep going up to maxErrorRetries", () => {
    expect(decideErrorRetry({ attempt: 8, kind: "network", elapsedMs: 0, maxErrorRetries: 8 }).retry).toBe(true);
    expect(decideErrorRetry({ attempt: 9, kind: "network", elapsedMs: 0, maxErrorRetries: 8 }).retry).toBe(false);
  });

  test("rate limits ride out brief throttles but stop at the rate-limit cap", () => {
    // Rides out a few 429s instead of giving up after 2...
    expect(decideErrorRetry({ attempt: 6, kind: "rate_limit", elapsedMs: 0, maxErrorRetries: 10 }).retry).toBe(true);
    // ...but is still bounded so a sustained throttle can't loop forever.
    expect(decideErrorRetry({ attempt: 7, kind: "rate_limit", elapsedMs: 0, maxErrorRetries: 10 }).retry).toBe(false);
  });

  test("the cumulative time budget stops retrying regardless of attempt count", () => {
    // Already spent ~179.5s — the next backoff would exceed the 180s budget.
    expect(
      decideErrorRetry({ attempt: 2, kind: "network", elapsedMs: 179_500, maxErrorRetries: 8 }).retry,
    ).toBe(false);
    // Well within the budget → still retries.
    expect(
      decideErrorRetry({ attempt: 2, kind: "network", elapsedMs: 1_000, maxErrorRetries: 8 }).retry,
    ).toBe(true);
  });
});
