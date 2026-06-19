import { afterEach, describe, expect, test } from "bun:test";
import {
  clearLearnedContextLimit,
  getLearnedContextLimit,
  noteLearnedContextLimit,
} from "./learned-context-limit";

const MODEL = "z-ai/glm-5.2";

afterEach(() => {
  clearLearnedContextLimit();
});

describe("learned-context-limit", () => {
  test("returns null until a limit is learned", () => {
    expect(getLearnedContextLimit(MODEL)).toBeNull();
  });

  test("remembers a reported limit per model", () => {
    noteLearnedContextLimit(MODEL, 1_048_576);
    expect(getLearnedContextLimit(MODEL)).toBe(1_048_576);
    expect(getLearnedContextLimit("other/model")).toBeNull();
  });

  test("keeps the tightest observed limit", () => {
    noteLearnedContextLimit(MODEL, 1_048_576);
    noteLearnedContextLimit(MODEL, 262_144);
    noteLearnedContextLimit(MODEL, 524_288);
    expect(getLearnedContextLimit(MODEL)).toBe(262_144);
  });

  test("ignores undefined / non-positive values", () => {
    noteLearnedContextLimit(MODEL, undefined);
    noteLearnedContextLimit(MODEL, 0);
    noteLearnedContextLimit(MODEL, -5);
    expect(getLearnedContextLimit(MODEL)).toBeNull();
  });
});
