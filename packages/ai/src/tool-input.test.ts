import { describe, expect, test } from "bun:test";
import { parseCodingToolInput } from "./tool-input";

describe("parseCodingToolInput", () => {
  test("validates and applies tool schema defaults", () => {
    expect(
      parseCodingToolInput("web_search", {
        query: "Lightcode",
      }),
    ).toEqual({
      query: "Lightcode",
      provider: "auto",
      maxResults: 3,
    });
  });

  test("coerces common provider argument type mistakes", () => {
    expect(
      parseCodingToolInput("web_search", {
        query: "Lightcode",
        maxResults: "5",
      }),
    ).toMatchObject({ maxResults: 5 });
  });

  test("still rejects genuinely missing required input", () => {
    expect(() => parseCodingToolInput("web_search", {})).toThrow();
  });
});
