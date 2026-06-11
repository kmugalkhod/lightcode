import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
  buildProviderView,
  computeCompactionCutoffIndex,
} from "./build-provider-view";
import { normalizeContextOptimizerConfig } from "./config";
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

  test("blocks compaction while tool work is unresolved", () => {
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

    expect(view.needsCompaction).toBe(false);
    expect(view.compactionBlockedReason).toBe("unresolved_tool_work");
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
