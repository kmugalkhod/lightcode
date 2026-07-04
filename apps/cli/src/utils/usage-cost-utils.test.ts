import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
  computeSessionCostUsd,
  computeUsageCostUsd,
  formatUsd,
  type ModelPricingInfo,
} from "./usage-cost-utils";

const pricing: ModelPricingInfo = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cachedInputPerMTok: 0.3,
};

function assistantMessageWithUsage(
  id: string,
  usage: Record<string, number>,
): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text: "ok" }],
    metadata: { usage },
  } as UIMessage;
}

describe("computeUsageCostUsd", () => {
  test("prices input and output tokens", () => {
    const cost = computeUsageCostUsd(
      { inputTokens: 1_000_000, outputTokens: 100_000 },
      pricing,
    );

    expect(cost).toBeCloseTo(3 + 1.5, 6);
  });

  test("bills cached input tokens at the cache-read rate", () => {
    const cost = computeUsageCostUsd(
      { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 500_000 },
      pricing,
    );

    // 500k fresh at $3/MTok + 500k cached at $0.3/MTok
    expect(cost).toBeCloseTo(1.5 + 0.15, 6);
  });

  test("falls back to full input rate when cache pricing is unknown", () => {
    const cost = computeUsageCostUsd(
      { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 },
      { ...pricing, cachedInputPerMTok: null },
    );

    expect(cost).toBeCloseTo(3, 6);
  });

  test("returns null without usage or pricing", () => {
    expect(computeUsageCostUsd(undefined, pricing)).toBeNull();
    expect(
      computeUsageCostUsd({ inputTokens: 10, outputTokens: 10 }, null),
    ).toBeNull();
    expect(computeUsageCostUsd({}, pricing)).toBeNull();
  });
});

describe("computeSessionCostUsd", () => {
  test("sums every assistant turn's usage", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] } as UIMessage,
      assistantMessageWithUsage("a1", {
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
      assistantMessageWithUsage("a2", {
        inputTokens: 0,
        outputTokens: 1_000_000,
      }),
    ];

    expect(computeSessionCostUsd(messages, pricing)).toBeCloseTo(3 + 15, 6);
  });

  test("returns null when no turn reported usage", () => {
    const messages: UIMessage[] = [
      { id: "a1", role: "assistant", parts: [] } as unknown as UIMessage,
    ];

    expect(computeSessionCostUsd(messages, pricing)).toBeNull();
  });
});

describe("formatUsd", () => {
  test("formats normal and sub-cent values", () => {
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0)).toBe("$0.00");
  });
});
