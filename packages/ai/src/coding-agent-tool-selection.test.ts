import { describe, expect, test } from "bun:test";
import {
  limitProviderActiveTools,
  selectCodingAgentIntentTools,
} from "./coding-agent";

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

  test("selects compact git tools for git prompts", () => {
    const tools = selectCodingAgentIntentTools({
      mode: "build",
      prompt: "Use tool_search to find git tools, then check git status.",
      messages: undefined,
    });

    expect(tools).toContain("tool_search");
    expect(tools).toContain("git_status");
    expect(tools).not.toContain("git_diff");
    expect(tools.length).toBeLessThan(4);
  });

  test("does not send tools for non-coding explanation prompts", () => {
    expect(
      selectCodingAgentIntentTools({
        mode: "build",
        prompt: "Explain recursion in simple words.",
        messages: undefined,
      }),
    ).toEqual([]);
  });

  test("selects write tools for implementation prompts", () => {
    const tools = selectCodingAgentIntentTools({
      mode: "build",
      prompt: "Create a file named plan-test.txt",
      messages: undefined,
    });

    expect(tools).toContain("write_file");
    expect(tools).toContain("edit_file");
    expect(tools).not.toContain("todo_write");
    expect(tools).not.toContain("bash");
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
