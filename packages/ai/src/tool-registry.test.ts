import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  codingToolDescriptions,
  codingToolInputSchemas,
  codingToolOutputSchemas,
  codingToolPermissionRequirements,
  codingToolProviderInputSchemas,
} from "./agent-tools";
import {
  codingAgentModes,
  codingAgentToolNameSchema,
  type CodingAgentMode,
  type CodingAgentToolName,
} from "./coding-agent-modes";
import {
  codingToolRegistry,
  getRegistryToolsForMode,
  isStrictCodingTool,
} from "./tool-registry";

const toolNames = Object.keys(codingToolRegistry) as CodingAgentToolName[];

describe("codingToolRegistry consistency", () => {
  test("covers the tool-name schema once and preserves registry mode order", () => {
    expect(toolNames).toEqual([...codingAgentToolNameSchema.options]);

    for (const mode of ["build", "plan"] as const satisfies readonly CodingAgentMode[]) {
      expect(getRegistryToolsForMode(mode)).toEqual([
        ...codingAgentModes[mode].activeTools,
      ]);
    }
  });

  test("keeps every derived schema, description, and permission map aligned", () => {
    for (const toolName of toolNames) {
      const entry = codingToolRegistry[toolName];
      expect(entry.permissionSubject).toBe(toolName);
      expect(codingToolDescriptions[toolName]).toBe(entry.description);
      expect(codingToolInputSchemas[toolName]).toBe(entry.inputSchema);
      expect(codingToolProviderInputSchemas[toolName]).toBe(
        entry.providerInputSchema,
      );
      expect(codingToolOutputSchemas[toolName]).toBe(entry.outputSchema);
      expect(codingToolPermissionRequirements[toolName]).toBe(
        entry.permissionMode,
      );
      expect(new Set(entry.modes).size).toBe(entry.modes.length);
    }
  });

  test("no provider tool has a parameter name that prefixes another", () => {
    // Models confuse prefix pairs: with edit_file's `replace` + `replaceAll`,
    // DeepSeek sent `{path, replaceAll, search}` in 7 of 26 edits — the flag
    // where the replacement text belonged.
    const collisions: string[] = [];
    for (const toolName of Object.keys(codingToolRegistry) as Array<keyof typeof codingToolRegistry>) {
      const schema = codingToolRegistry[toolName].providerInputSchema;
      if (!(schema instanceof z.ZodObject)) continue;
      const names = Object.keys(schema.shape).map((name) => name.toLowerCase());
      for (const name of names) {
        for (const other of names) {
          if (name !== other && other.startsWith(name)) {
            collisions.push(`${toolName}: ${name} / ${other}`);
          }
        }
      }
    }

    expect(collisions).toEqual([]);
  });

  test("marks the compact base as core and optional capability families as specialized", () => {
    expect(
      getRegistryToolsForMode("build").filter(
        (name) => codingToolRegistry[name].activation === "core",
      ),
    ).toEqual([
      "agent",
      "list_files",
      "glob_search",
      "read_file",
      "grep",
      "git_status",
      "git_diff",
      "git_log",
      "git_show",
      "tool_search",
      "skill",
      "request_user_input",
      "todo_write",
      "write_file",
      "edit_file",
      "bash",
      "bash_output",
      "bash_stop",
    ]);
    expect(
      getRegistryToolsForMode("plan").filter(
        (name) => codingToolRegistry[name].activation === "core",
      ),
    ).toEqual([
      "agent",
      "list_files",
      "glob_search",
      "read_file",
      "grep",
      "git_status",
      "git_diff",
      "git_log",
      "git_show",
      "tool_search",
      "skill",
      "request_user_input",
    ]);

    for (const toolName of [
      "list_mcp_resources",
      "read_mcp_resource",
      "call_mcp_tool",
      "web_fetch",
      "web_search",
    ] as const) {
      expect(codingToolRegistry[toolName].activation).toBe("specialized");
    }
  });

  test("the model can set a bash timeout, run in the background, and offer answer choices", () => {
    // These options were once cut from the provider schemas to fit the strict
    // budget, leaving every command capped at 30s and every question free-text.
    const providerFields = (toolName: CodingAgentToolName) => {
      const schema = codingToolRegistry[toolName].providerInputSchema;
      return schema instanceof z.ZodObject ? Object.keys(schema.shape) : [];
    };
    expect(providerFields("bash")).toEqual(["command", "timeoutMs", "runInBackground"]);
    expect(providerFields("bash_output")).toEqual(["jobId", "waitMs"]);
    expect(providerFields("request_user_input")).toEqual(["question", "header", "options"]);
    expect(isStrictCodingTool("bash")).toBe(false);
    expect(isStrictCodingTool("request_user_input")).toBe(false);
    expect(isStrictCodingTool("read_file")).toBe(true);
  });
});
