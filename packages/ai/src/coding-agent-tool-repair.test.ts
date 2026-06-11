import { describe, expect, test } from "bun:test";
import { InvalidToolInputError, NoSuchToolError } from "ai";
import type { LanguageModelV3ToolCall } from "@ai-sdk/provider";
import {
  repairCodingAgentToolCall,
  repairToolName,
} from "./coding-agent-tool-repair";

const availableTools = [
  "list_files",
  "glob_search",
  "read_file",
  "grep",
  "todo_write",
  "write_file",
  "edit_file",
  "bash",
  "web_fetch",
  "web_search",
];

const tools = Object.fromEntries(availableTools.map((name) => [name, {}]));

function toolCall(
  toolName: string,
  input: string,
): LanguageModelV3ToolCall {
  return { type: "tool-call", toolCallId: "tc-1", toolName, input };
}

describe("repairToolName", () => {
  test("normalizes case, hyphens, and prefixes", () => {
    expect(repairToolName("Read_File", availableTools)).toBe("read_file");
    expect(repairToolName("read-file", availableTools)).toBe("read_file");
    expect(repairToolName("functions.read_file", availableTools)).toBe("read_file");
  });

  test("maps common aliases", () => {
    expect(repairToolName("read", availableTools)).toBe("read_file");
    expect(repairToolName("search", availableTools)).toBe("grep");
    expect(repairToolName("shell", availableTools)).toBe("bash");
    expect(repairToolName("ls", availableTools)).toBe("list_files");
    expect(repairToolName("str_replace_editor", availableTools)).toBe("edit_file");
  });

  test("fuzzy matches small typos", () => {
    expect(repairToolName("read_fle", availableTools)).toBe("read_file");
    expect(repairToolName("glob_serch", availableTools)).toBe("glob_search");
  });

  test("returns null when nothing is close", () => {
    expect(repairToolName("deploy_to_production", availableTools)).toBeNull();
  });
});

describe("repairCodingAgentToolCall", () => {
  test("repairs a misnamed tool", async () => {
    const call = toolCall("read", '{"path":"a.ts"}');
    const repaired = await repairCodingAgentToolCall({
      toolCall: call,
      tools,
      error: new NoSuchToolError({ toolName: "read", availableTools }),
    });
    expect(repaired?.toolName).toBe("read_file");
    expect(repaired?.input).toBe('{"path":"a.ts"}');
  });

  test("returns null for unmatchable tool names", async () => {
    const repaired = await repairCodingAgentToolCall({
      toolCall: toolCall("launch_rocket", "{}"),
      tools,
      error: new NoSuchToolError({ toolName: "launch_rocket", availableTools }),
    });
    expect(repaired).toBeNull();
  });

  test("repairs malformed argument JSON", async () => {
    const call = toolCall("read_file", "{path: 'a.ts'}");
    const repaired = await repairCodingAgentToolCall({
      toolCall: call,
      tools,
      error: new InvalidToolInputError({
        toolName: "read_file",
        toolInput: call.input,
        cause: new Error("parse error"),
      }),
    });
    expect(repaired).not.toBeNull();
    expect(JSON.parse(repaired!.input)).toEqual({ path: "a.ts" });
  });

  test("returns null for hopeless input", async () => {
    const call = toolCall("read_file", "not json at all");
    const repaired = await repairCodingAgentToolCall({
      toolCall: call,
      tools,
      error: new InvalidToolInputError({
        toolName: "read_file",
        toolInput: call.input,
        cause: new Error("parse error"),
      }),
    });
    expect(repaired).toBeNull();
  });
});
