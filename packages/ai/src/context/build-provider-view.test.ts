import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
  buildProviderView,
  capCoverageToTokenBudget,
  computeCompactionCutoffIndex,
} from "./build-provider-view";
import { normalizeContextOptimizerConfig } from "./config";
import { estimateStructuralTokens } from "./fit-to-budget";
import { contextSummaryMessageId } from "./heuristic-summary";

function textMessage(role: UIMessage["role"], id: string, text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

function conversation(userTurns: number, textLength = 10): UIMessage[] {
  const messages: UIMessage[] = [];
  for (let turn = 0; turn < userTurns; turn += 1) {
    messages.push(textMessage("user", `u${turn}`, "q".repeat(textLength)));
    messages.push(textMessage("assistant", `a${turn}`, "r".repeat(textLength)));
  }
  return messages;
}

const smallWindowConfig = normalizeContextOptimizerConfig({
  contextWindowOverride: 8_000,
  preserveRecentMessages: 2,
});

const contextState = {
  summary: "Lightcode context summary\n\n- Earlier work happened.",
  anchorMessageId: "a1",
  coveredMessageCount: 4,
  tier: "llm" as const,
};

describe("buildProviderView", () => {
  test("passes small histories through untouched", () => {
    const messages = conversation(2);
    const view = buildProviderView({
      messages,
      contextState: null,
      config: normalizeContextOptimizerConfig(undefined),
    });

    expect(view.providerMessages).toEqual(messages);
    expect(view.needsCompaction).toBe(false);
    expect(view.tier1).toBeNull();
    expect(view.anchorResolved).toBe(false);
  });

  test("replaces the covered prefix with the stored summary", () => {
    const messages = conversation(4); // u0 a0 u1 a1 u2 a2 u3 a3
    const view = buildProviderView({
      messages,
      contextState,
      config: normalizeContextOptimizerConfig(undefined),
    });

    expect(view.anchorResolved).toBe(true);
    expect(view.providerMessages[0].id).toBe(contextSummaryMessageId);
    expect(view.providerMessages[0].role).toBe("system");
    // Anchor a1 is at index 3; everything after it is preserved.
    expect(view.providerMessages.slice(1).map((message) => message.id)).toEqual([
      "u2",
      "a2",
      "u3",
      "a3",
    ]);
  });

  test("ignores stored state when the anchor is missing", () => {
    const messages = conversation(2); // ids u0..a1 — use state anchored elsewhere
    const view = buildProviderView({
      messages,
      contextState: { ...contextState, anchorMessageId: "missing" },
      config: normalizeContextOptimizerConfig(undefined),
    });

    expect(view.anchorResolved).toBe(false);
    expect(view.providerMessages).toEqual(messages);
  });

  test("flags compaction when over the threshold", () => {
    // 8k-token window → compact at 6.4k tokens ≈ 25.6k chars.
    const messages = conversation(8, 4_000);
    const view = buildProviderView({
      messages,
      contextState: null,
      config: smallWindowConfig,
    });

    expect(view.needsCompaction).toBe(true);
    expect(view.compactionBlockedReason).toBeNull();
    expect(view.coveredMessages.length).toBeGreaterThan(0);
    // The preserved window starts at a user message.
    expect(messages[view.compactionCutoffIndex].role).toBe("user");
  });

  test("blocks compaction while interactions are pending", () => {
    const view = buildProviderView({
      messages: conversation(8, 4_000),
      contextState: null,
      config: smallWindowConfig,
      pendingInteractionCount: 1,
    });

    expect(view.needsCompaction).toBe(false);
    expect(view.compactionBlockedReason).toBe("pending_interactions");
  });

  test("blocks compaction when tool work in the covered region is unresolved", () => {
    const messages = conversation(8, 4_000);
    // An early (covered) assistant turn with an unresolved tool call.
    messages[1] = {
      id: "a0",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          toolCallId: "bash-1",
          state: "input-available",
          input: { command: "bun test" },
        } as unknown as UIMessage["parts"][number],
      ],
    };

    const view = buildProviderView({
      messages,
      contextState: null,
      config: smallWindowConfig,
    });

    expect(view.coveredMessages.some((m) => m.id === "a0")).toBe(true);
    expect(view.needsCompaction).toBe(false);
    expect(view.compactionBlockedReason).toBe("unresolved_tool_work");
  });

  test("compacts despite unresolved tool work in the preserved tail", () => {
    // The in-flight tool call lives in the recent window, which compaction never
    // touches, so settled older history should still compact.
    const messages = conversation(8, 4_000);
    messages.push({
      id: "a-tools",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          toolCallId: "bash-1",
          state: "input-available",
          input: { command: "bun test" },
        } as unknown as UIMessage["parts"][number],
      ],
    });

    const view = buildProviderView({
      messages,
      contextState: null,
      config: smallWindowConfig,
    });

    // The unresolved call is preserved, not covered.
    expect(view.coveredMessages.some((m) => m.id === "a-tools")).toBe(false);
    expect(view.needsCompaction).toBe(true);
    expect(view.compactionBlockedReason).toBeNull();
  });

  test("fires the trigger on the structural floor when the calibrated estimate under-reports", () => {
    // A large history whose final assistant turn carries a tiny provider usage
    // count (as if the provider only saw a narrow compacted view). The
    // usage-calibrated estimate is blind; the structural floor is not.
    const messages: UIMessage[] = [];
    for (let i = 0; i < 6; i += 1) {
      messages.push(textMessage("user", `u${i}`, "q".repeat(4_000)));
      messages.push(textMessage("assistant", `a${i}`, "r".repeat(4_000)));
    }
    messages[messages.length - 1] = {
      id: "aLast",
      role: "assistant",
      parts: [{ type: "text", text: "done" }],
      metadata: { usage: { totalTokens: 50 } },
    } as UIMessage;

    const view = buildProviderView({
      messages,
      contextState: null,
      config: smallWindowConfig,
    });

    // Calibrated estimate alone would NOT cross the compaction threshold...
    expect(view.estimate.tokens).toBeLessThan(
      smallWindowConfig.compactAtFraction * view.inputBudgetTokens,
    );
    // ...but the structural floor makes compaction fire anyway.
    expect(view.needsCompaction).toBe(true);
  });

  test("blocks compaction when only the recent window remains", () => {
    const messages = [
      textMessage("user", "u0", "x".repeat(40_000)),
      textMessage("assistant", "a0", "done"),
    ];

    const view = buildProviderView({
      messages,
      contextState: null,
      config: smallWindowConfig,
    });

    expect(view.needsCompaction).toBe(false);
    expect(view.compactionBlockedReason).toBe("not_enough_messages");
  });

  test("applies Tier-1 pruning above the prune threshold", () => {
    const messages = conversation(8, 10);
    // Inflate an old assistant message with a huge resolved tool output.
    messages[1] = {
      id: "a0",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          toolCallId: "bash-1",
          state: "output-available",
          input: { command: "ls -R" },
          output: { stdout: "y".repeat(30_000) },
        } as unknown as UIMessage["parts"][number],
      ],
    };

    const view = buildProviderView({
      messages,
      contextState: null,
      config: smallWindowConfig,
    });

    expect(view.tier1).not.toBeNull();
    expect(view.tier1?.elidedToolOutputs).toBe(1);
    expect(view.estimate.tokens).toBeLessThan(3_000);
  });
});

describe("capCoverageToTokenBudget", () => {
  const big = (id: string) => textMessage("user", id, "x".repeat(4_000));

  test("keeps the leading run that fits the budget", () => {
    const messages = [big("u0"), big("u1"), big("u2")];
    const per = estimateStructuralTokens([messages[0]]);
    // Budget fits two whole messages but not three.
    const capped = capCoverageToTokenBudget(messages, per * 2 + Math.floor(per / 2));
    expect(capped.map((m) => m.id)).toEqual(["u0", "u1"]);
  });

  test("keeps everything when the budget is ample", () => {
    const messages = [big("u0"), big("u1"), big("u2")];
    const capped = capCoverageToTokenBudget(messages, 1_000_000);
    expect(capped).toHaveLength(3);
  });

  test("always keeps at least one message even if it exceeds the budget", () => {
    const messages = [big("u0"), big("u1")];
    const capped = capCoverageToTokenBudget(messages, 1);
    expect(capped.map((m) => m.id)).toEqual(["u0"]);
  });
});

describe("computeCompactionCutoffIndex", () => {
  test("returns the anchor boundary when nothing can be covered", () => {
    const messages = conversation(1);
    expect(computeCompactionCutoffIndex(messages, 6, 0)).toBe(0);
  });

  test("snaps down to a user message after the anchor", () => {
    const messages = conversation(5); // 10 messages, users at 0,2,4,6,8
    // candidate = 10 - 3 = 7 → snapped to user index 6.
    expect(computeCompactionCutoffIndex(messages, 3, 2)).toBe(6);
  });
});
