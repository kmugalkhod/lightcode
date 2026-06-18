import { describe, expect, test } from "bun:test";
import { isToolUIPart, type UIMessage } from "ai";
import { formatChatStreamError } from "../chat-error";
import {
  countCompletedWork,
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

  test("prunes incomplete streaming tool input but keeps completed parts", () => {
    const sanitized = sanitizeMessagesForRetry([
      userMessage(),
      assistantWithToolPart("input-streaming"),
    ]);

    // The completed "Reading the file." text part is preserved; only the
    // still-streaming tool call is pruned.
    expect(sanitized).toHaveLength(2);
    expect(sanitized[1].role).toBe("assistant");
    expect(toolPartsOf(sanitized[1])).toHaveLength(0);
    expect(sanitized[1].parts.some((part) => part.type === "text")).toBe(true);
  });

  test("drops a trailing assistant message with only incomplete parts", () => {
    const onlyStreaming = {
      id: "a-empty",
      role: "assistant",
      parts: [
        {
          type: "tool-read_file",
          toolCallId: "call-x",
          state: "input-streaming",
          input: {},
        },
      ],
    } as unknown as UIMessage;

    const sanitized = sanitizeMessagesForRetry([userMessage(), onlyStreaming]);

    expect(sanitized).toHaveLength(1);
    expect(sanitized[0].role).toBe("user");
  });

  test("preserves finished steps of a multi-step turn cut off mid-stream", () => {
    // A multi-step agent turn is a single assistant message holding every
    // step's parts. A drop mid-third-step must not discard steps 1 and 2.
    const multiStep = {
      id: "a-multi",
      role: "assistant",
      parts: [
        { type: "text", text: "Step 1.", state: "done" },
        {
          type: "tool-read_file",
          toolCallId: "call-1",
          state: "output-available",
          input: { path: "a.ts" },
          output: { content: "a" },
        },
        { type: "text", text: "Step 2.", state: "done" },
        {
          type: "tool-read_file",
          toolCallId: "call-2",
          state: "output-available",
          input: { path: "b.ts" },
          output: { content: "b" },
        },
        { type: "text", text: "Now step 3", state: "streaming" },
        {
          type: "tool-read_file",
          toolCallId: "call-3",
          state: "input-streaming",
          input: {},
        },
      ],
    } as unknown as UIMessage;

    const sanitized = sanitizeMessagesForRetry([userMessage(), multiStep]);

    expect(sanitized).toHaveLength(2);
    const completedTools = toolPartsOf(sanitized[1]);
    // Both finished tool calls (with results) survive; the incomplete third is gone.
    expect(completedTools).toHaveLength(2);
    expect(
      completedTools.every(
        (part) => Reflect.get(part, "state") === "output-available",
      ),
    ).toBe(true);
    // The streaming step-3 text is pruned; the finished step texts remain.
    const texts = sanitized[1].parts
      .filter((part) => part.type === "text")
      .map((part) => Reflect.get(part, "text"));
    expect(texts).toEqual(["Step 1.", "Step 2."]);
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

describe("countCompletedWork", () => {
  test("counts completed text and terminal tool parts, ignores in-flight ones", () => {
    const messages = [
      userMessage(),
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "done part", state: "done" },
          { type: "text", text: "still going", state: "streaming" },
          {
            type: "tool-read_file",
            toolCallId: "c1",
            state: "output-available",
            input: {},
            output: { content: "x" },
          },
          {
            type: "tool-read_file",
            toolCallId: "c2",
            state: "input-streaming",
            input: {},
          },
        ],
      } as unknown as UIMessage,
    ];

    // 1 completed text + 1 terminal tool = 2; the streaming text and
    // input-streaming tool are not yet finished work. (User text parts have no
    // state and count as completed.)
    expect(countCompletedWork(messages)).toBe(3);
  });

  test("is monotonic as work completes", () => {
    const before = [userMessage()];
    const after = [
      userMessage(),
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-read_file",
            toolCallId: "c1",
            state: "output-available",
            input: {},
            output: { content: "x" },
          },
        ],
      } as unknown as UIMessage,
    ];

    expect(countCompletedWork(after)).toBeGreaterThan(countCompletedWork(before));
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
