import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContextReport } from "../lib/api";
import { ContextMeter, contextUsage } from "./context-meter";

function report(tokens: number, compactedTokens = 0): ContextReport {
  return {
    estimate: { tokens, basis: "estimate" },
    contextWindow: 100_000,
    breakdown: {
      systemTokens: 0,
      toolTokens: 0,
      messageTokens: tokens,
      mediaTokens: 0,
      inputTokens: tokens,
      inputBudgetTokens: 90_000,
      messageBudgetTokens: 80_000,
      reservedOutputTokens: 10_000,
      contextWindow: 100_000,
      remainingTokens: 100_000 - tokens,
      compactedTokens,
    },
    withinBudget: true,
  };
}

describe("context meter", () => {
  test("uses the terminal's 60% / 85% thresholds", () => {
    expect(contextUsage(report(59_000))).toEqual({ percentage: 59, level: "normal" });
    expect(contextUsage(report(60_000)).level).toBe("warning");
    expect(contextUsage(report(85_000)).level).toBe("critical");
    expect(contextUsage(report(250_000)).percentage).toBe(100);
  });

  test("renders the percentage and mentions compaction", () => {
    const html = renderToStaticMarkup(<ContextMeter report={report(42_000, 12_000)} />);
    expect(html).toContain("ctx 42%");
    expect(html).toContain("compacted");
    expect(html).toContain("42k of 100k tokens");
    expect(renderToStaticMarkup(<ContextMeter report={null} />)).toBe("");
  });
});
