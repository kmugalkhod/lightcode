import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  defaultContextOptimizerConfig,
  normalizeContextOptimizerConfig,
  resolveContextWindowTokens,
  resolveInputBudgetTokens,
} from "./config";

describe("maxCoverageTokensPerCompaction", () => {
  test("defaults are present after normalization", () => {
    expect(
      normalizeContextOptimizerConfig(undefined).maxCoverageTokensPerCompaction,
    ).toBe(12_000);
    expect(defaultContextOptimizerConfig.maxCoverageTokensPerCompaction).toBe(
      12_000,
    );
  });

  test("an explicit value round-trips", () => {
    expect(
      normalizeContextOptimizerConfig({ maxCoverageTokensPerCompaction: 20_000 })
        .maxCoverageTokensPerCompaction,
    ).toBe(20_000);
  });
});

describe("resolveContextWindowTokens", () => {
  test("prefers override, then model window, then default", () => {
    expect(
      resolveContextWindowTokens({
        config: { ...defaultContextOptimizerConfig, contextWindowOverride: 50_000 },
        modelContextWindow: 200_000,
      }),
    ).toBe(50_000);

    expect(
      resolveContextWindowTokens({
        config: defaultContextOptimizerConfig,
        modelContextWindow: 200_000,
      }),
    ).toBe(200_000);

    expect(
      resolveContextWindowTokens({ config: defaultContextOptimizerConfig }),
    ).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  test("clamps an optimistic catalog window to a learned endpoint limit", () => {
    expect(
      resolveContextWindowTokens({
        config: defaultContextOptimizerConfig,
        modelContextWindow: 2_000_000,
        endpointLimitTokens: 1_048_576,
      }),
    ).toBe(1_048_576);
  });

  test("ignores a non-positive endpoint limit", () => {
    expect(
      resolveContextWindowTokens({
        config: defaultContextOptimizerConfig,
        modelContextWindow: 200_000,
        endpointLimitTokens: 0,
      }),
    ).toBe(200_000);
  });
});

describe("resolveInputBudgetTokens", () => {
  test("subtracts reserved output and applies the safety margin", () => {
    // (1_048_576 - 131_072) * 0.92
    expect(
      resolveInputBudgetTokens({
        contextWindow: 1_048_576,
        reservedOutputTokens: 131_072,
      }),
    ).toBe(Math.floor((1_048_576 - 131_072) * 0.92));
  });

  test("treats missing reserved output as zero", () => {
    expect(
      resolveInputBudgetTokens({ contextWindow: 100_000 }),
    ).toBe(Math.floor(100_000 * 0.92));
  });

  test("never goes negative when output reservation exceeds the window", () => {
    expect(
      resolveInputBudgetTokens({
        contextWindow: 10_000,
        reservedOutputTokens: 50_000,
      }),
    ).toBe(0);
  });
});
