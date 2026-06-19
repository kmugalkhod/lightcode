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

  test("includes explicitly requested situational tools alongside the core set", () => {
    const tools = selectCodingAgentIntentTools({
      mode: "build",
      prompt: "Use tool_search to find git tools, then check git status.",
      messages: undefined,
    });

    expect(tools).toContain("tool_search");
    expect(tools).toContain("git_status");
    // Core read tools are always present so the agent can inspect the workspace.
    expect(tools).toContain("read_file");
    expect(tools).not.toContain("git_diff"); // not requested
    expect(tools.length).toBeLessThanOrEqual(7);
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

  test("build-mode tasks include write and shell tools by default", () => {
    const tools = selectCodingAgentIntentTools({
      mode: "build",
      prompt: "Create a file named plan-test.txt",
      messages: undefined,
    });

    expect(tools).toContain("write_file");
    expect(tools).toContain("edit_file");
    expect(tools).toContain("bash"); // build mode can run commands without re-prompting
    expect(tools).not.toContain("todo_write"); // situational, not requested
  });

  test("caps provider tools to Anthropic-safe compact sets", () => {
    const tools = limitProviderActiveTools([
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
    ]);

    expect(tools).toEqual([
      "list_files",
      "glob_search",
      "read_file",
      "grep",
      "git_status",
      "git_diff",
      "git_log",
    ]);
    expect(tools.length).toBeLessThanOrEqual(7);
  });

  test("keeps core edit and shell tools before nice-to-have tools", () => {
    const tools = limitProviderActiveTools([
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
    ]);

    expect(tools).toEqual([
      "list_files",
      "glob_search",
      "read_file",
      "grep",
      "write_file",
      "edit_file",
      "bash",
    ]);
    expect(tools.length).toBeLessThanOrEqual(7);
  });
});
