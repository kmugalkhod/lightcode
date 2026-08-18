import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { buildContextSummary } from "./heuristic-summary";

describe("buildContextSummary", () => {
  test("retains constraints, test failures, and tool approval outcomes", () => {
    const messages: UIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [
          {
            type: "text",
            text: "You must keep AI SDK 6 and do not truncate the latest request.",
          },
        ],
      },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-bash",
            toolCallId: "bash-1",
            state: "output-error",
            input: { command: "bun test" },
            errorText: "2 tests failed in context-compaction.test.ts",
          } as unknown as UIMessage["parts"][number],
          {
            type: "tool-write_file",
            toolCallId: "write-1",
            state: "output-denied",
            input: { path: "src/index.ts" },
            approval: {
              id: "approval-1",
              approved: false,
              reason: "User denied this change",
            },
          } as unknown as UIMessage["parts"][number],
        ],
      },
    ];

    const summary = buildContextSummary({
      existingSummary: null,
      removedMessages: messages,
      summaryMaxChars: 4_000,
    });

    expect(summary).toContain("must keep AI SDK 6");
    expect(summary).toContain("2 tests failed");
    expect(summary).toContain("User denied this change");
  });
});
