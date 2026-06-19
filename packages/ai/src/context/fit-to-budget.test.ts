import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
  estimateStructuralTokens,
  fitMessagesToBudget,
} from "./fit-to-budget";
import { isElidedToolOutput } from "./tier1-prune";
import { createSummaryMessage } from "./heuristic-summary";

function textMessage(role: UIMessage["role"], id: string, text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

function toolMessage(id: string, output: unknown): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-read_file",
        toolCallId: `${id}-call`,
        state: "output-available",
        input: { path: `/tmp/${id}.txt` },
        output,
      } as unknown as UIMessage["parts"][number],
    ],
  };
}

const big = (n: number) => "x".repeat(n);

describe("fitMessagesToBudget", () => {
  test("returns the view unchanged when already within budget", () => {
    const messages = [
      textMessage("user", "u1", "hello"),
      textMessage("assistant", "a1", "hi there"),
    ];
    const result = fitMessagesToBudget(messages, {
      inputBudgetTokens: 10_000,
      preserveRecentMessages: 6,
    });

    expect(result.fitted).toBe(false);
    expect(result.withinBudget).toBe(true);
    expect(result.messages).toEqual(messages);
  });

  test("is idempotent: a second pass changes nothing", () => {
    const messages = [
      toolMessage("t1", big(40_000)),
      textMessage("user", "u1", big(40_000)),
      textMessage("assistant", "a1", "done"),
    ];
    const once = fitMessagesToBudget(messages, {
      inputBudgetTokens: 2_000,
      preserveRecentMessages: 1,
    });
    const twice = fitMessagesToBudget(once.messages, {
      inputBudgetTokens: 2_000,
      preserveRecentMessages: 1,
    });

    expect(once.withinBudget).toBe(true);
    expect(twice.fitted).toBe(false);
    expect(twice.messages).toEqual(once.messages);
  });

  test("elides tool outputs before touching user text", () => {
    const messages = [
      toolMessage("t1", big(60_000)),
      textMessage("user", "u1", "keep me"),
      textMessage("assistant", "a1", "and me"),
    ];
    // Budget large enough that eliding the one big tool output alone suffices.
    const result = fitMessagesToBudget(messages, {
      inputBudgetTokens: 200,
      preserveRecentMessages: 2,
    });

    expect(result.elidedToolOutputs).toBe(1);
    const elided = result.messages[0].parts[0] as unknown as {
      output: unknown;
    };
    expect(isElidedToolOutput(elided.output)).toBe(true);
    // The preserved user/assistant text is intact.
    expect(result.messages[1]).toEqual(messages[1]);
    expect(result.messages[2]).toEqual(messages[2]);
    expect(result.withinBudget).toBe(true);
  });

  test("drops oldest non-preserved messages when eliding is not enough", () => {
    const messages = [
      textMessage("user", "u1", big(40_000)),
      textMessage("assistant", "a1", big(40_000)),
      textMessage("user", "u2", "recent question"),
      textMessage("assistant", "a2", "recent answer"),
    ];
    const result = fitMessagesToBudget(messages, {
      inputBudgetTokens: 500,
      preserveRecentMessages: 2,
    });

    expect(result.droppedMessages).toBeGreaterThan(0);
    // The two recent messages survive.
    expect(result.messages.some((m) => m.id === "u2")).toBe(true);
    expect(result.messages.some((m) => m.id === "a2")).toBe(true);
    expect(result.withinBudget).toBe(true);
  });

  test("hard-truncates a single oversized preserved message", () => {
    // One enormous message that the drop pass cannot remove (it is the only
    // preserved message). This is the hole overflow recovery cannot close.
    const messages = [textMessage("user", "u1", big(500_000))];
    const result = fitMessagesToBudget(messages, {
      inputBudgetTokens: 1_000,
      preserveRecentMessages: 6,
    });

    expect(result.truncatedTextParts).toBeGreaterThan(0);
    expect(result.withinBudget).toBe(true);
    expect(estimateStructuralTokens(result.messages)).toBeLessThanOrEqual(1_000);
  });

  test("keeps the compaction summary message during the drop pass", () => {
    const summary = createSummaryMessage("dense recap of earlier work");
    const messages = [
      summary,
      textMessage("user", "u1", big(40_000)),
      textMessage("assistant", "a1", big(40_000)),
      textMessage("user", "u2", "recent"),
    ];
    const result = fitMessagesToBudget(messages, {
      inputBudgetTokens: 800,
      preserveRecentMessages: 1,
    });

    expect(result.messages.some((m) => m.id === summary.id)).toBe(true);
    expect(result.withinBudget).toBe(true);
  });

  test("always lands within budget for a massive history", () => {
    const messages: UIMessage[] = [];
    for (let i = 0; i < 50; i += 1) {
      messages.push(textMessage("user", `u${i}`, big(20_000)));
      messages.push(toolMessage(`t${i}`, big(20_000)));
    }
    const result = fitMessagesToBudget(messages, {
      inputBudgetTokens: 5_000,
      preserveRecentMessages: 6,
    });

    expect(result.withinBudget).toBe(true);
    expect(estimateStructuralTokens(result.messages)).toBeLessThanOrEqual(5_000);
  });
});
