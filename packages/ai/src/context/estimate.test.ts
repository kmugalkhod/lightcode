import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
  estimateContextTokens,
  estimateProviderMessageTokens,
  getMessageUsageMetadata,
} from "./estimate";

function textMessage(
  role: UIMessage["role"],
  id: string,
  text: string,
  metadata?: unknown,
): UIMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

describe("estimateContextTokens", () => {
  test("uses the chars heuristic when no usage metadata exists", () => {
    const estimate = estimateContextTokens([
      textMessage("user", "u0", "x".repeat(4_000)),
    ]);

    expect(estimate.basis).toBe("heuristic");
    // ~4 chars per token plus JSON envelope overhead.
    expect(estimate.tokens).toBeGreaterThan(1_000);
    expect(estimate.tokens).toBeLessThan(1_200);
  });

  test("counts tool parts, not just text", () => {
    const withTool: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          toolCallId: "bash-1",
          state: "output-available",
          input: { command: "ls" },
          output: { stdout: "y".repeat(8_000) },
        } as unknown as UIMessage["parts"][number],
      ],
    };

    const withoutTool = estimateContextTokens([
      textMessage("assistant", "a1", ""),
    ]);
    const estimate = estimateContextTokens([withTool]);

    expect(estimate.tokens).toBeGreaterThan(withoutTool.tokens + 1_500);
  });

  test("calibrates on the most recent assistant usage metadata", () => {
    const messages = [
      textMessage("user", "u0", "x".repeat(50_000)),
      textMessage("assistant", "a1", "done", {
        usage: { totalTokens: 5_000 },
        modelId: "claude-haiku-4-5",
      }),
    ];

    const estimate = estimateContextTokens(messages);

    expect(estimate.basis).toBe("usage_calibrated");
    expect(estimate.tokens).toBe(5_000);
  });

  test("prefers final-step context over cumulative billing usage", () => {
    const messages = [
      textMessage("assistant", "a1", "done", {
        usage: { inputTokens: 30_000, outputTokens: 2_000, totalTokens: 32_000 },
        context: { inputTokens: 7_500, contextWindow: 128_000 },
      }),
    ];

    expect(estimateContextTokens(messages).tokens).toBe(7_500);
  });

  test("can isolate message/media usage from fixed system and tool overhead", () => {
    const messages = [
      textMessage("assistant", "a1", "done", {
        usage: { totalTokens: 32_000 },
        context: {
          inputTokens: 7_500,
          contextWindow: 128_000,
          systemTokens: 1_000,
          toolTokens: 1_500,
          messageTokens: 4_800,
          mediaTokens: 200,
        },
      }),
    ];

    expect(estimateContextTokens(messages).tokens).toBe(7_500);
    expect(estimateProviderMessageTokens(messages).tokens).toBe(5_000);
  });

  test("adds a heuristic tail for messages after the usage anchor", () => {
    const messages = [
      textMessage("assistant", "a0", "done", {
        usage: { totalTokens: 5_000 },
      }),
      textMessage("user", "u1", "z".repeat(4_000)),
    ];

    const estimate = estimateContextTokens(messages);

    expect(estimate.basis).toBe("usage_calibrated");
    expect(estimate.tokens).toBeGreaterThan(6_000);
    expect(estimate.tokens).toBeLessThan(6_200);
  });

  test("falls back to inputTokens + outputTokens when totalTokens is missing", () => {
    const messages = [
      textMessage("assistant", "a0", "done", {
        usage: { inputTokens: 4_000, outputTokens: 500 },
      }),
    ];

    expect(estimateContextTokens(messages).tokens).toBe(4_500);
  });

  test("ignores malformed metadata", () => {
    const messages = [
      textMessage("assistant", "a0", "done", { usage: "not-an-object" }),
    ];

    expect(estimateContextTokens(messages).basis).toBe("heuristic");
    expect(getMessageUsageMetadata(messages[0])).toBeNull();
  });

  test("ignores usage metadata on user messages", () => {
    const messages = [
      textMessage("user", "u0", "hello", { usage: { totalTokens: 1 } }),
    ];

    expect(estimateContextTokens(messages).basis).toBe("heuristic");
  });
});
