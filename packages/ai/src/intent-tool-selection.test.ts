import { describe, expect, test } from "bun:test";
import {
  collectToolSearchDiscoveredTools,
  selectCodingAgentIntentTools,
} from "./intent-tool-selection";

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

  test("keyword-free build tasks get compact core tools including edits and bash", () => {
    for (const phrase of [
      "continue",
      "fix the failing test",
      "design a multiplayer system",
    ]) {
      const selected = tools(phrase);
      expect(selected).toContain("read_file");
      expect(selected).toContain("tool_search");
      expect(selected).toContain("write_file");
      expect(selected).toContain("edit_file");
      expect(selected).toContain("bash");
      expect(selected).not.toContain("git_status");
      expect(selected).not.toContain("web_search");
      expect(selected).not.toContain("skill");
    }
  });

  test("plan core stays read-only and retains interactive questions", () => {
    const selected = tools("design a multiplayer system", "plan");
    expect(selected).toContain("read_file");
    expect(selected).toContain("tool_search");
    expect(selected).toContain("request_user_input");
    expect(selected).not.toContain("todo_write");
    expect(selected).not.toContain("write_file");
    expect(selected).not.toContain("edit_file");
    expect(selected).not.toContain("bash");
  });

  test("clear Git intent activates Git tools without unrelated schemas", () => {
    const selected = tools("check git status and review the commit history");
    expect(selected).toContain("git_status");
    expect(selected).toContain("git_diff");
    expect(selected).toContain("git_log");
    expect(selected).toContain("git_show");
    expect(selected).not.toContain("web_search");
    expect(selected).not.toContain("list_mcp_resources");
  });

  test("clear web intent activates only web tools allowed by the mode", () => {
    const build = tools("search the web and fetch https://example.com/docs");
    expect(build).toContain("web_fetch");
    expect(build).toContain("web_search");

    const plan = tools("look up the latest release online", "plan");
    expect(plan).toContain("web_search");
    expect(plan).not.toContain("web_fetch");
  });

  test("clear MCP intent activates MCP tools allowed by the mode", () => {
    const build = tools("use the MCP server resources for this task");
    expect(build).toContain("list_mcp_resources");
    expect(build).toContain("read_mcp_resource");
    expect(build).toContain("call_mcp_tool");

    const plan = tools("inspect the model context protocol resources", "plan");
    expect(plan).toContain("list_mcp_resources");
    expect(plan).toContain("read_mcp_resource");
    expect(plan).not.toContain("call_mcp_tool");
  });

  test("skill intent supports explicit wording and known skill names", () => {
    expect(tools("load the ai-sdk skill")).toContain("skill");

    const selected = selectCodingAgentIntentTools({
      mode: "build",
      prompt: "",
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: "Use $pr-description" }],
        },
      ],
      availableSkillNames: ["pr-description"],
    });
    expect(selected).toContain("skill");
  });
});

describe("collectToolSearchDiscoveredTools", () => {
  test("reads completed ModelMessage JSON outputs in registry order", () => {
    const selected = collectToolSearchDiscoveredTools({
      mode: "build",
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "tool_search",
              output: {
                type: "json",
                value: {
                  results: [
                    { name: "web_search" },
                    { name: "git_diff" },
                    { name: "web_search" },
                    { name: "not_a_tool" },
                  ],
                },
              },
            },
          ],
        },
      ],
    });

    expect(selected).toEqual(["git_diff", "web_search"]);
  });

  test("reads completed static and dynamic UI tool parts", () => {
    const selected = collectToolSearchDiscoveredTools({
      mode: "build",
      messages: [
        {
          role: "assistant",
          parts: [
            {
              type: "tool-tool_search",
              state: "output-available",
              output: { results: [{ name: "skill" }] },
            },
            {
              type: "dynamic-tool",
              toolName: "tool_search",
              state: "output-available",
              output: { results: [{ name: "call_mcp_tool" }] },
            },
          ],
        },
      ],
    });

    expect(selected).toEqual(["skill", "call_mcp_tool"]);
  });

  test("rejects unfinished, failed, malformed, and wrong-tool outputs", () => {
    const selected = collectToolSearchDiscoveredTools({
      mode: "build",
      messages: [
        {
          role: "assistant",
          parts: [
            {
              type: "tool-tool_search",
              state: "input-available",
              output: { results: [{ name: "web_search" }] },
            },
            {
              type: "dynamic-tool",
              toolName: "tool_search",
              state: "output-error",
              output: { results: [{ name: "git_diff" }] },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolName: "grep",
              output: {
                type: "json",
                value: { results: [{ name: "skill" }] },
              },
            },
            {
              type: "tool-result",
              toolName: "tool_search",
              output: { type: "text", value: "not-json" },
            },
          ],
        },
      ],
    });

    expect(selected).toEqual([]);
  });

  test("filters discoveries through active mode permissions", () => {
    const selected = collectToolSearchDiscoveredTools({
      mode: "plan",
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolName: "tool_search",
              output: {
                type: "json",
                value: {
                  results: [
                    { name: "git_diff" },
                    { name: "web_search" },
                    { name: "web_fetch" },
                    { name: "call_mcp_tool" },
                    { name: "write_file" },
                    { name: "bash" },
                  ],
                },
              },
            },
          ],
        },
      ],
    });

    expect(selected).toEqual(["git_diff", "web_search"]);
  });
});
