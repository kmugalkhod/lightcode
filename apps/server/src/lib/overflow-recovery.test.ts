import { describe, expect, test } from "bun:test";
import {
  clearContextOverflowRounds,
  getOverflowPreserveRecentMessages,
  noteContextOverflow,
} from "./overflow-recovery";

describe("overflow recovery schedule", () => {
  test("progresses 4 → 2 → 1 → 0 and clamps", () => {
    const sessionId = "session-schedule";
    clearContextOverflowRounds(sessionId);

    expect(getOverflowPreserveRecentMessages(sessionId)).toBeNull();

    noteContextOverflow(sessionId);
    expect(getOverflowPreserveRecentMessages(sessionId)).toBe(4);

    noteContextOverflow(sessionId);
    expect(getOverflowPreserveRecentMessages(sessionId)).toBe(2);

    noteContextOverflow(sessionId);
    expect(getOverflowPreserveRecentMessages(sessionId)).toBe(1);

    noteContextOverflow(sessionId);
    expect(getOverflowPreserveRecentMessages(sessionId)).toBe(0);

    noteContextOverflow(sessionId);
    expect(getOverflowPreserveRecentMessages(sessionId)).toBe(0);
  });

  test("clears on success and is per-session", () => {
    clearContextOverflowRounds("a");
    clearContextOverflowRounds("b");

    noteContextOverflow("a");
    expect(getOverflowPreserveRecentMessages("a")).toBe(4);
    expect(getOverflowPreserveRecentMessages("b")).toBeNull();

    clearContextOverflowRounds("a");
    expect(getOverflowPreserveRecentMessages("a")).toBeNull();
  });
});
