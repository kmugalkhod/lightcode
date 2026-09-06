import { describe, expect, test } from "bun:test";
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
      "tool_search",
      "skill",
      "todo_write",
      "write_file",
      "edit_file",
      "bash",
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
      "tool_search",
      "skill",
      "request_user_input",
    ]);

    for (const toolName of [
      "git_status",
      "git_diff",
      "git_log",
      "git_show",
      "list_mcp_resources",
      "read_mcp_resource",
      "call_mcp_tool",
      "web_fetch",
      "web_search",
    ] as const) {
      expect(codingToolRegistry[toolName].activation).toBe("specialized");
    }
  });
});
