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

  test("keyword-free real tasks still get tools (the 'No tools available' fix)", () => {
    for (const phrase of [
      "design a multiplayer system for my game",
      "help me with my game",
      "make it faster",
      "what should the architecture look like",
    ]) {
      const selected = tools(phrase);
      // Always able to inspect the workspace...
      expect(selected).toContain("read_file");
      expect(selected).toContain("glob_search");
      // ...and, in build mode, to actually edit and run.
      expect(selected).toContain("edit_file");
      expect(selected).toContain("bash");
    }
  });

  test("plan mode keyword-free task gets read tools but no write/run tools", () => {
    const selected = tools("design a multiplayer system", "plan");
    expect(selected).toContain("read_file");
    expect(selected).not.toContain("write_file");
    expect(selected).not.toContain("edit_file");
    expect(selected).not.toContain("bash");
  });

  test("explicit situational intent survives the provider tool cap", () => {
    const selected = tools("show me the git status");
    expect(selected).toContain("git_status");
    expect(selected).toContain("read_file");
    expect(selected.length).toBeLessThanOrEqual(7);
  });

  test("never exceeds the provider tool cap", () => {
    const selected = tools("review the repo, run the tests, check git diff, and fetch https://x.com");
    expect(selected.length).toBeLessThanOrEqual(7);
    expect(selected).toContain("read_file");
  });
});
