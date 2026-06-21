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

  test("git-only build prompt still exposes write/run tools (the bug fix)", () => {
    // Previously this prompt matched git_status + git_diff + git_log and the
    // 7-tool cap sliced off write_file/edit_file/bash, so the build agent
    // could not edit files. The full set must now be available.
    const selected = tools("review the repo and check git status, diff, and log");
    expect(selected).toContain("read_file");
    expect(selected).toContain("git_status");
    expect(selected).toContain("git_diff");
    expect(selected).toContain("write_file");
    expect(selected).toContain("edit_file");
    expect(selected).toContain("bash");
  });

  test("build mode exposes the full build tool set for any real task", () => {
    const selected = tools("fix the bug");
    for (const toolName of [
      "read_file",
      "write_file",
      "edit_file",
      "bash",
      "git_status",
      "todo_write",
      "skill",
      "web_search",
    ] as const) {
      expect(selected).toContain(toolName);
    }
  });

  test("the skill tool is always available in build mode", () => {
    const selected = selectCodingAgentIntentTools({
      mode: "build",
      prompt: "",
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: "fix the null check in parser.ts" }],
        },
      ],
      availableSkillNames: ["pr-description"],
    });
    expect(selected).toContain("skill");
  });
});
