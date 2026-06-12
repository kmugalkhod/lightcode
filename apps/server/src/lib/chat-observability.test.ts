import { describe, expect, test } from "bun:test";
import { APICallError } from "ai";
import { classifyChatError } from "./chat-observability";

function apiError(statusCode: number, responseBody: string) {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: "https://openrouter.ai/api/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseBody,
  });
}

describe("classifyChatError", () => {
  test("400 invalid request is not retryable", () => {
    const classified = classifyChatError(
      apiError(400, '{"error":{"message":"tool_use ids must have a corresponding tool_result"}}'),
    );

    expect(classified.kind).toBe("invalid_request");
    expect(classified.retryable).toBe(false);
    expect(classified.statusCode).toBe(400);
    expect(classified.message).toContain("tool_result");
  });

  test("400 with context markers classifies as context_overflow", () => {
    const classified = classifyChatError(
      apiError(400, '{"error":{"message":"This model\'s maximum context length is 196608 tokens"}}'),
    );

    // Retryable: each overflow round triggers a harder server-side compaction.
    expect(classified.kind).toBe("context_overflow");
    expect(classified.retryable).toBe(true);
  });

  test.each([
    [429, "rate_limit"],
    [500, "provider_unavailable"],
    [502, "provider_unavailable"],
    [503, "provider_unavailable"],
    [504, "provider_unavailable"],
    [408, "provider_unavailable"],
    [409, "provider_unavailable"],
  ] as const)("HTTP %d is retryable (%s)", (status, kind) => {
    const classified = classifyChatError(apiError(status, "upstream error"));

    expect(classified.kind).toBe(kind);
    expect(classified.retryable).toBe(true);
  });

  test.each([
    [401, "auth"],
    [403, "auth"],
    [402, "billing"],
  ] as const)("HTTP %d is terminal (%s)", (status, kind) => {
    const classified = classifyChatError(apiError(status, "denied"));

    expect(classified.kind).toBe(kind);
    expect(classified.retryable).toBe(false);
  });

  test("plain network errors fall back to heuristics and stay retryable", () => {
    const classified = classifyChatError(new Error("socket hang up (ECONNRESET)"));

    expect(classified.kind).toBe("network");
    expect(classified.retryable).toBe(true);
  });

  test("abort errors are classified as aborted", () => {
    const abort = new Error("The operation was aborted.");
    abort.name = "AbortError";

    expect(classifyChatError(abort).kind).toBe("aborted");
  });

  test("unknown errors are not retried blindly", () => {
    const classified = classifyChatError(new Error("model does not exist"));

    expect(classified.kind).toBe("unknown");
    expect(classified.retryable).toBe(false);
  });
});
