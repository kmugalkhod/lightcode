import { describe, expect, test } from "bun:test";
import { isToolUIPart, type UIMessage } from "ai";
import { formatChatStreamError } from "../chat-error";
import {
  isRecoverableChatErrorMessage,
  normalizeChatErrorMessage,
  sanitizeMessagesForRetry,
} from "./use-coding-session-chat";

function userMessage(id = "u1"): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text: "do the task" }],
  } as UIMessage;
}

function assistantWithToolPart(state: string, extra: Record<string, unknown> = {}): UIMessage {
  return {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "text", text: "Reading the file.", state: "done" },
      {
        type: "tool-read_file",
        toolCallId: "call-1",
        state,
        input: { path: "src/index.ts" },
        ...extra,
      },
    ],
  } as unknown as UIMessage;
}

function toolPartsOf(message: UIMessage) {
  return message.parts.filter((part) => isToolUIPart(part));
}

describe("sanitizeMessagesForRetry", () => {
  test("rewrites dangling input-available tool calls to output-error", () => {
    const sanitized = sanitizeMessagesForRetry([
      userMessage(),
      assistantWithToolPart("input-available"),
    ]);

    expect(sanitized).toHaveLength(2);
    const [toolPart] = toolPartsOf(sanitized[1]);
    expect(Reflect.get(toolPart, "state")).toBe("output-error");
    expect(String(Reflect.get(toolPart, "errorText"))).toContain("interrupted");
  });

  test("drops trailing assistant messages still streaming tool input", () => {
    const sanitized = sanitizeMessagesForRetry([
      userMessage(),
      assistantWithToolPart("input-streaming"),
    ]);

    expect(sanitized).toHaveLength(1);
    expect(sanitized[0].role).toBe("user");
  });

  test("rewrites approval-state tool calls left behind by an abort", () => {
    const sanitized = sanitizeMessagesForRetry([
      userMessage(),
      assistantWithToolPart("approval-requested"),
    ]);

    const [toolPart] = toolPartsOf(sanitized[1]);
    expect(Reflect.get(toolPart, "state")).toBe("output-error");
  });

  test("keeps terminal tool parts untouched", () => {
    const messages = [
      userMessage(),
      assistantWithToolPart("output-available", { output: { content: "ok" } }),
    ];
    const sanitized = sanitizeMessagesForRetry(messages);

    expect(sanitized[1]).toBe(messages[1]);
    const [toolPart] = toolPartsOf(sanitized[1]);
    expect(Reflect.get(toolPart, "state")).toBe("output-available");
  });

  test("result never contains unresolved tool parts", () => {
    const sanitized = sanitizeMessagesForRetry([
      userMessage(),
      assistantWithToolPart("input-available"),
      userMessage("u2"),
      assistantWithToolPart("output-error", { errorText: "boom" }),
    ]);

    for (const message of sanitized) {
      for (const part of toolPartsOf(message)) {
        expect([
          "output-available",
          "output-error",
          "output-denied",
        ]).toContain(String(Reflect.get(part, "state")));
      }
    }
  });
});

describe("structured chat errors", () => {
  test("non-retryable envelope is not treated as recoverable", () => {
    const message = formatChatStreamError({
      kind: "invalid_request",
      statusCode: 400,
      retryable: false,
      message: "tool call had no result block",
    });

    // The raw payload mentions "tool" but classification wins over regex.
    expect(isRecoverableChatErrorMessage(message)).toBe(false);
  });

  test("retryable envelope is recoverable", () => {
    const message = formatChatStreamError({
      kind: "provider_unavailable",
      statusCode: 503,
      retryable: true,
      message: "upstream connect error",
    });

    expect(isRecoverableChatErrorMessage(message)).toBe(true);
  });

  test("plain disconnect-looking messages still match heuristics", () => {
    expect(isRecoverableChatErrorMessage("fetch failed: socket hang up")).toBe(
      true,
    );
    expect(isRecoverableChatErrorMessage("model does not exist")).toBe(false);
  });

  test("normalizeChatErrorMessage surfaces the real provider error", () => {
    const message = formatChatStreamError({
      kind: "invalid_request",
      statusCode: 400,
      retryable: false,
      message: "messages.5: tool_use ids must have a corresponding tool_result",
    });

    const normalized = normalizeChatErrorMessage(message);
    expect(normalized).toContain("HTTP 400");
    expect(normalized).toContain("tool_result");
    expect(normalized).not.toContain("LIGHTCODE_ERROR");
  });
});
