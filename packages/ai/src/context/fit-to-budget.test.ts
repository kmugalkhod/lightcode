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
      textMessage("user", "u0", "old request"),
      toolMessage("t1", big(40_000)),
      textMessage("user", "u1", "recent request"),
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
    // The old turn is removed atomically; no orphan assistant remains.
    expect(result.messages.some((m) => m.id === "u1")).toBe(false);
    expect(result.messages.some((m) => m.id === "a1")).toBe(false);
    expect(result.withinBudget).toBe(true);
  });

  test("treats recent-turn retention as soft under hard budget pressure", () => {
    const messages = [
      textMessage("user", "u1", big(40_000)),
      textMessage("assistant", "a1", big(40_000)),
      textMessage("user", "u2", "latest request must survive"),
    ];
    const result = fitMessagesToBudget(messages, {
      inputBudgetTokens: 500,
      // Deliberately protects both turns during the quality-preserving pass.
      preserveRecentTokens: 100_000,
    });

    expect(result.withinBudget).toBe(true);
    expect(result.messages.map((message) => message.id)).toEqual(["u2"]);
    expect(result.messages[0]).toEqual(messages[2]);
  });

  test("refuses to truncate a single oversized latest user message", () => {
    const messages = [textMessage("user", "u1", big(500_000))];
    const result = fitMessagesToBudget(messages, {
      inputBudgetTokens: 1_000,
      preserveRecentMessages: 6,
    });

    expect(result.truncatedTextParts).toBe(0);
    expect(result.withinBudget).toBe(false);
    expect(result.messages).toEqual(messages);
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

  test("drops the compaction summary only when the latest request needs the space", () => {
    const summary = createSummaryMessage(big(40_000));
    const latest = textMessage("user", "u2", "latest request");
    const result = fitMessagesToBudget([summary, latest], {
      inputBudgetTokens: 100,
      preserveRecentTokens: 100_000,
    });

    expect(result.withinBudget).toBe(true);
    expect(result.messages).toEqual([latest]);
  });

  test("always lands within budget for a massive history", () => {
    const messages: UIMessage[] = [];
    for (let i = 0; i < 50; i += 1) {
      messages.push(
        textMessage("user", `u${i}`, i === 49 ? "latest request" : big(20_000)),
      );
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
