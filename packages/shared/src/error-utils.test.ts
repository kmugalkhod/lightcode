import { describe, expect, test } from "bun:test";
import { getErrorMessage } from "./error-utils";

describe("getErrorMessage", () => {
  test("returns the message from Error instances", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
  });

  test("returns non-empty strings as-is", () => {
    expect(getErrorMessage("plain failure")).toBe("plain failure");
  });

  test("falls back for empty and non-error values", () => {
    expect(getErrorMessage(new Error(""))).toBe("Unknown error");
    expect(getErrorMessage("   ")).toBe("Unknown error");
    expect(getErrorMessage({ code: 500 })).toBe("Unknown error");
    expect(getErrorMessage(undefined, "custom fallback")).toBe("custom fallback");
  });
});
