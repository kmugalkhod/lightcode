import { afterEach, describe, expect, test } from "bun:test";
import {
  assertNotRepeatingToolCall,
  RepeatedToolCallError,
  resetToolCallRepeatGuard,
} from "./tool-call-repeat-guard";

afterEach(() => {
  resetToolCallRepeatGuard();
});

describe("assertNotRepeatingToolCall", () => {
  test("throws on the third identical consecutive call", () => {
    const call = () =>
      assertNotRepeatingToolCall("read_file", { path: "a.ts" }, "turn-1");

    expect(call).not.toThrow(); // 1
    expect(call).not.toThrow(); // 2
    expect(call).toThrow(RepeatedToolCallError); // 3
  });

  test("a different call in between resets the counter", () => {
    const readA = () =>
      assertNotRepeatingToolCall("read_file", { path: "a.ts" }, "turn-1");

    readA();
    readA();
    // Different file breaks the streak.
    assertNotRepeatingToolCall("read_file", { path: "b.ts" }, "turn-1");
    expect(readA).not.toThrow(); // back to count 1
  });

  test("distinct arguments never trip the guard", () => {
    for (let i = 0; i < 5; i += 1) {
      expect(() =>
        assertNotRepeatingToolCall("read_file", { path: `f${i}.ts` }, "turn-1"),
      ).not.toThrow();
    }
  });

  test("ignores non-guarded (mutating) tools", () => {
    const call = () =>
      assertNotRepeatingToolCall("edit_file", { path: "a.ts" }, "turn-1");
    for (let i = 0; i < 5; i += 1) {
      expect(call).not.toThrow();
    }
  });

  test("no-op without a turnKey", () => {
    const call = () =>
      assertNotRepeatingToolCall("read_file", { path: "a.ts" }, undefined);
    for (let i = 0; i < 5; i += 1) {
      expect(call).not.toThrow();
    }
  });

  test("separate turns are tracked independently", () => {
    assertNotRepeatingToolCall("read_file", { path: "a.ts" }, "turn-1");
    assertNotRepeatingToolCall("read_file", { path: "a.ts" }, "turn-1");
    // Same args but a fresh turn — starts its own count.
    expect(() =>
      assertNotRepeatingToolCall("read_file", { path: "a.ts" }, "turn-2"),
    ).not.toThrow();
  });
});
