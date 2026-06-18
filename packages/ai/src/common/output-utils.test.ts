import { describe, expect, test } from "bun:test";
import { DEFAULT_TOOL_TEXT_OUTPUT_CHARS } from "../constants";
import { truncateText } from "./output-utils";

describe("truncateText", () => {
  test("leaves short input untouched", () => {
    const result = truncateText("hello world", 6000);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("hello world");
  });

  test("keeps both head and tail when truncating", () => {
    const text = `HEAD_MARKER${"x".repeat(5000)}TAIL_MARKER`;
    const result = truncateText(text, 1000);

    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("HEAD_MARKER")).toBe(true);
    expect(result.text.endsWith("TAIL_MARKER")).toBe(true);
    expect(result.text).toContain("characters omitted");
  });

  test("never exceeds maxChars, even at a small cap", () => {
    const text = "y".repeat(10_000);
    for (const maxChars of [200, 500, 1000, 6000]) {
      const result = truncateText(text, maxChars);
      expect(result.truncated).toBe(true);
      expect(result.text.length).toBeLessThanOrEqual(maxChars);
    }
  });

  test("reports the exact omitted character count", () => {
    const text = "z".repeat(8000);
    const result = truncateText(text, 2000);
    const match = result.text.match(/\[(\d+) characters omitted/);
    expect(match).not.toBeNull();
    const omitted = Number(match?.[1]);
    // head + tail + omitted must reconstruct the original length.
    const kept = text.length - omitted;
    expect(kept).toBeGreaterThan(0);
    expect(omitted).toBe(text.length - kept);
  });

  test("defaults to DEFAULT_TOOL_TEXT_OUTPUT_CHARS", () => {
    const text = "a".repeat(DEFAULT_TOOL_TEXT_OUTPUT_CHARS + 1000);
    const result = truncateText(text);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(DEFAULT_TOOL_TEXT_OUTPUT_CHARS);
  });
});
