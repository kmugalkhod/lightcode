import { describe, expect, test } from "bun:test";
import {
  limitProviderActiveTools,
  selectCodingAgentIntentTools,
} from "./intent-tool-selection";

describe("coding agent dynamic tool selection", () => {
  test("does not send tools for casual chat", () => {
    expect(
      selectCodingAgentIntentTools({
        mode: "build",
        prompt: "How are you?",
        messages: undefined,
      }),
    ).toEqual([]);
    expect(
      selectCodingAgentIntentTools({
        mode: "build",
        prompt: "What's up",
        messages: undefined,
      }),
    ).toEqual([]);
  });

  test("exposes the full build tool set for a real task", () => {
    const tools = selectCodingAgentIntentTools({
      mode: "build",
      prompt: "Use tool_search to find git tools, then check git status.",
      messages: undefined,
    });

    expect(tools).toContain("tool_search");
    expect(tools).toContain("git_status");
    expect(tools).toContain("read_file");
    // The model now gets the whole mode set and chooses for itself, so
    // unrequested tools are available too (opencode-style).
    expect(tools).toContain("git_diff");
    expect(tools).toContain("write_file");
  });

  test("non-casual prompts always get tools (never an empty set)", () => {
    // We cannot reliably tell "explain recursion" from "explain the auth code",
    // so any non-greeting message gets the core tools; the model uses them only
    // if needed. This is the fix for the 'No tools are available' failure.
    const tools = selectCodingAgentIntentTools({
      mode: "build",
      prompt: "Explain recursion in simple words.",
      messages: undefined,
    });

    expect(tools).toContain("read_file");
    expect(tools.length).toBeGreaterThan(0);
  });

  test("build-mode tasks include write, shell, and planning tools by default", () => {
    const tools = selectCodingAgentIntentTools({
      mode: "build",
      prompt: "Create a file named plan-test.txt",
      messages: undefined,
    });

    expect(tools).toContain("write_file");
    expect(tools).toContain("edit_file");
    expect(tools).toContain("bash"); // build mode can run commands without re-prompting
    expect(tools).toContain("todo_write"); // always available so the agent can track work
  });

  test("limitProviderActiveTools passes through sets within the cap", () => {
    const input = [
      "list_files",
      "glob_search",
      "read_file",
      "grep",
      "git_status",
      "git_diff",
      "git_log",
      "git_show",
      "tool_search",
      "request_user_input",
    ] as const;

    // 10 tools is well under the 24-tool cap, so nothing is dropped or reordered.
    expect(limitProviderActiveTools([...input])).toEqual([...input]);
  });

  test("keeps core edit and shell tools first when a tighter provider cap applies", () => {
    // Safety net for weak providers: when an explicit cap is below the tool
    // count, priority ordering ensures read/write/run tools survive first.
    const tools = limitProviderActiveTools(
      [
        "list_files",
        "glob_search",
        "read_file",
        "grep",
        "git_status",
        "tool_search",
        "todo_write",
        "write_file",
        "edit_file",
        "bash",
      ],
      7,
    );

    expect(tools).toEqual([
      "list_files",
      "glob_search",
      "read_file",
      "grep",
      "write_file",
      "edit_file",
      "bash",
    ]);
    expect(tools.length).toBe(7);
  });
});
