import { describe, expect, test } from "bun:test";
import {
  expandPastePlaceholders,
  formatPastePlaceholder,
  shouldCollapsePaste,
} from "./paste-placeholders";

describe("shouldCollapsePaste", () => {
  test("collapses pastes with more than five lines", () => {
    expect(shouldCollapsePaste("a\nb\nc\nd\ne\nf")).toBe(true);
  });

  test("collapses long single-line pastes over the char threshold", () => {
    expect(shouldCollapsePaste("x".repeat(401))).toBe(true);
  });

  test("leaves short pastes untouched", () => {
    expect(shouldCollapsePaste("just a line or two\nhere")).toBe(false);
  });
});

describe("formatPastePlaceholder", () => {
  test("renders the Claude-Code-style label with the line count", () => {
    const text = Array.from({ length: 42 }, () => "line").join("\n");
    expect(formatPastePlaceholder(1, text)).toBe("[Pasted text #1 +42 lines]");
  });
});

describe("expandPastePlaceholders", () => {
  test("splices stored full text back into the display text", () => {
    const store = new Map([[1, "FULL\nPASTED\nBODY"]]);
    const display = "before [Pasted text #1 +3 lines] after";
    expect(expandPastePlaceholders(display, store)).toBe(
      "before FULL\nPASTED\nBODY after",
    );
  });

  test("expands multiple placeholders independently", () => {
    const store = new Map([
      [1, "first body"],
      [2, "second body"],
    ]);
    const display = "[Pasted text #1 +1 lines] and [Pasted text #2 +1 lines]";
    expect(expandPastePlaceholders(display, store)).toBe(
      "first body and second body",
    );
  });

  test("leaves unknown or edited placeholders as-is", () => {
    const store = new Map([[1, "body"]]);
    expect(expandPastePlaceholders("[Pasted text #9 +2 lines]", store)).toBe(
      "[Pasted text #9 +2 lines]",
    );
  });
});
