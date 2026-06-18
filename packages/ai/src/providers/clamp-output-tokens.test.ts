import { describe, expect, test } from "bun:test";
import {
  clampMaxOutputTokens,
  resolveMaxOutputTokens,
} from "./clamp-output-tokens";

const DEFAULT = 32_768;

describe("clampMaxOutputTokens", () => {
  test("lowers the configured value to the model cap", () => {
    expect(clampMaxOutputTokens(32768, 1000)).toBe(1000);
  });

  test("keeps the configured value when it is below the cap", () => {
    expect(clampMaxOutputTokens(512, 8192)).toBe(512);
  });

  test("falls back to configured when the cap is unknown", () => {
    expect(clampMaxOutputTokens(32768, null)).toBe(32768);
    expect(clampMaxOutputTokens(32768, undefined)).toBe(32768);
  });

  test("ignores non-positive or non-finite caps", () => {
    expect(clampMaxOutputTokens(4096, 0)).toBe(4096);
    expect(clampMaxOutputTokens(4096, -10)).toBe(4096);
    expect(clampMaxOutputTokens(4096, Number.NaN)).toBe(4096);
    expect(clampMaxOutputTokens(4096, Number.POSITIVE_INFINITY)).toBe(4096);
  });
});

describe("resolveMaxOutputTokens", () => {
  test("uses the model's full budget when left at the default (minimax-m3: 512K)", () => {
    expect(resolveMaxOutputTokens(DEFAULT, DEFAULT, 512_000)).toBe(512_000);
  });

  test("keeps the default when the model advertises no cap", () => {
    expect(resolveMaxOutputTokens(DEFAULT, DEFAULT, null)).toBe(DEFAULT);
    expect(resolveMaxOutputTokens(DEFAULT, DEFAULT, undefined)).toBe(DEFAULT);
  });

  test("honors an explicit user value below the model cap", () => {
    expect(resolveMaxOutputTokens(8_000, DEFAULT, 512_000)).toBe(8_000);
  });

  test("clamps an explicit user value above the model cap", () => {
    expect(resolveMaxOutputTokens(600_000, DEFAULT, 512_000)).toBe(512_000);
  });

  test("honors an explicit value when the model cap is unknown", () => {
    expect(resolveMaxOutputTokens(64_000, DEFAULT, null)).toBe(64_000);
  });
});
