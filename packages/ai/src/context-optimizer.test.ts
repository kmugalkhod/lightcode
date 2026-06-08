import { describe, expect, test } from "bun:test";
import { safeValidateUIMessages, type UIMessage } from "ai";
import {
  estimateContextTokens,
  optimizeContextMessages,
  type ResolvedContextOptimizerConfig,
} from "./context-optimizer";

const compactNowConfig = {
  autoCompact: true,
  maxInputTokens: 1,
  preserveRecentMessages: 2,
  summaryMaxChars: 1_200,
} satisfies ResolvedContextOptimizerConfig;

function textMessage(
  role: UIMessage["role"],
  text: string,
  id: string,
): UIMessage {
  return {
    id,
    role,
    parts: [
      {
        type: "text",
        text,
      },
    ],
  };
}

function toolMessage({
  id,
  state = "output-available",
}: {
  id: string;
  state?: string;
}): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-read_file",
        toolCallId: `${id}-tool`,
        state,
        input: {
          path: "packages/ai/src/context-optimizer.ts",
        },
        output: {
          path: "packages/ai/src/context-optimizer.ts",
          content: "context optimizer source",
        },
      },
    ],
  } as unknown as UIMessage;
}

describe("context optimizer", () => {
  test("estimates message tokens from serialized UI messages", () => {
    const messages = [
      textMessage("user", "hello", "u1"),
      textMessage("assistant", "world", "a1"),
    ];

    expect(estimateContextTokens(messages)).toBeGreaterThan(0);
  });

  test("compacts older messages into a synthetic system summary", async () => {
    const messages = [
      textMessage(
        "user",
        "Please inspect packages/ai/src/context-optimizer.ts next.",
        "u1",
      ),
      toolMessage({ id: "tool-1" }),
      textMessage(
        "assistant",
        "Next: add tests and keep pending work visible.",
        "a1",
      ),
      textMessage("user", "Keep this recent request.", "u2"),
      textMessage("assistant", "Recent assistant reply.", "a2"),
    ];

    const result = optimizeContextMessages({
      messages,
      config: compactNowConfig,
    });

    expect(result.compacted).toBe(true);
    expect(result.removedMessageCount).toBe(3);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[1].id).toBe("u2");
    expect(result.messages[2].id).toBe("a2");
    expect(result.summary).toContain("Lightcode context summary");
    expect(result.summary).toContain("Scope: 3 earlier messages compacted");
    expect(result.summary).toContain("Recent user requests");
    expect(result.summary).toContain("Pending work");
    expect(result.summary).toContain("packages/ai/src/context-optimizer.ts");
    expect(result.summary).toContain("Tools used: read_file");

    const validation = await safeValidateUIMessages({
      messages: result.messages,
    });
    expect(validation.success).toBe(true);
  });

  test("merges repeated compactions without nesting previous context", () => {
    const first = optimizeContextMessages({
      messages: [
        textMessage("user", "Initial request for packages/ai/src/index.ts", "u1"),
        textMessage("assistant", "Working on the first part.", "a1"),
        textMessage("user", "Recent user request one.", "u2"),
        textMessage("assistant", "Recent assistant reply one.", "a2"),
      ],
      config: compactNowConfig,
    });
    expect(first.compacted).toBe(true);

    const second = optimizeContextMessages({
      messages: [
        ...first.messages,
        textMessage("user", "Please continue with remaining tests.", "u3"),
        textMessage("assistant", "Next: finish route coverage.", "a3"),
      ],
      config: compactNowConfig,
    });

    expect(second.compacted).toBe(true);
    expect(second.summary).toContain("Previously compacted context");
    expect(second.summary?.match(/Previously compacted context/g)).toHaveLength(1);
    expect(second.summary).toContain("Initial request");
  });

  test("keeps summary inside configured character budget", () => {
    const messages = Array.from({ length: 12 }, (_, index) =>
      textMessage(
        index % 2 === 0 ? "user" : "assistant",
        `Long message ${index} with next pending work in packages/ai/src/context-optimizer.ts. ${"x".repeat(200)}`,
        `m${index}`,
      ),
    );

    const result = optimizeContextMessages({
      messages,
      config: {
        ...compactNowConfig,
        summaryMaxChars: 300,
      },
    });

    expect(result.compacted).toBe(true);
    expect(result.summary?.length).toBeLessThanOrEqual(300);
    expect(result.summary).toContain("Additional summary detail omitted");
  });

  test("skips compaction below threshold, with pending interactions, or unresolved tool work", () => {
    const messages = [
      textMessage("user", "small", "u1"),
      textMessage("assistant", "small", "a1"),
    ];

    expect(
      optimizeContextMessages({
        messages,
        config: {
          ...compactNowConfig,
          maxInputTokens: 1_000_000,
        },
      }).skipReason,
    ).toBe("below_threshold");

    expect(
      optimizeContextMessages({
        messages: [...messages, textMessage("user", "another", "u2")],
        config: compactNowConfig,
        pendingInteractionCount: 1,
      }).skipReason,
    ).toBe("pending_interactions");

    expect(
      optimizeContextMessages({
        messages: [
          textMessage("user", "read a file", "u3"),
          toolMessage({ id: "tool-2", state: "input-available" }),
          textMessage("user", "recent", "u4"),
        ],
        config: compactNowConfig,
      }).skipReason,
    ).toBe("unresolved_tool_work");
  });

  test("can preserve zero recent messages for maximum compaction", () => {
    const messages = [
      textMessage("user", "one", "u1"),
      textMessage("assistant", "two", "a1"),
    ];

    const result = optimizeContextMessages({
      messages,
      config: {
        ...compactNowConfig,
        preserveRecentMessages: 0,
      },
    });

    expect(result.compacted).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("system");
  });
});

