import { describe, expect, test } from "bun:test";
import { selectCodingAgentIntentTools } from "./intent-tool-selection";

function tools(text: string, mode: "build" | "plan" = "build") {
  return selectCodingAgentIntentTools({
    mode,
    prompt: "",
    messages: [{ role: "user", parts: [{ type: "text", text }] }],
  });
}

describe("selectCodingAgentIntentTools", () => {
  test("casual messages select no tools (fast path stays available)", () => {
    expect(tools("hi")).toEqual([]);
    expect(tools("ok")).toEqual([]);
    expect(tools("thanks")).toEqual([]);
  });

  test("terse continuations select work tools in build mode", () => {
    for (const phrase of ["continue", "go on", "keep going", "proceed", "go ahead"]) {
      const selected = tools(phrase);
      expect(selected.length).toBeGreaterThan(0);
      expect(selected).toContain("read_file");
      expect(selected).toContain("edit_file");
      expect(selected).toContain("bash");
    }
  });

  test("explicit task prompts still select tools", () => {
    const selected = tools("fix the failing test and run typecheck");
    expect(selected).toContain("edit_file");
    expect(selected).toContain("bash");
  });

  test("review/explore phrasing selects read tools (agent path)", () => {
    for (const phrase of [
      "review this",
      "explain the code",
      "look at this project",
      "audit the repo",
    ]) {
      const selected = tools(phrase);
      expect(selected.length).toBeGreaterThan(0);
      expect(selected).toContain("read_file");
    }
  });
});
