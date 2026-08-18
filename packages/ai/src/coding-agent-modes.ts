import { z } from "zod";

const codingAgentToolNameOrder = [
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
  "list_mcp_resources",
  "read_mcp_resource",
  "call_mcp_tool",
  "request_user_input",
  "todo_write",
  "write_file",
  "edit_file",
  "bash",
  "web_fetch",
  "web_search",
] as const;

export type CodingAgentToolName = (typeof codingAgentToolNameOrder)[number];
export const codingAgentToolNameSchema = z.enum(codingAgentToolNameOrder);

export const codingAgentModeOrder = ["build", "plan"] as const;
export type CodingAgentMode = (typeof codingAgentModeOrder)[number];

export const codingAgentModeSchema = z.enum(codingAgentModeOrder);
export const defaultCodingAgentMode: CodingAgentMode = "build";

export interface CodingAgentModeDefinition {
  label: string;
  purpose: string;
  instructions: string;
  activeTools: readonly CodingAgentToolName[];
}

export const codingAgentModes: Record<CodingAgentMode, CodingAgentModeDefinition> = {
  build: {
    label: "Build",
    purpose: "Plan and implement changes with full coding tool access.",
    instructions:
      "You are in build mode. You should plan and execute coding tasks end-to-end, " +
      "including edits and shell commands when needed. Keep progress updates concise and concrete.",
    activeTools: [
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
      "list_mcp_resources",
      "read_mcp_resource",
      "call_mcp_tool",
      "todo_write",
      "write_file",
      "edit_file",
      "bash",
      "web_fetch",
      "web_search",
    ],
  },
  plan: {
    label: "Plan",
    purpose: "Read-only planning mode focused on safe analysis and implementation design.",
    instructions:
      "You are in plan mode (safe read-only mode). Do not attempt to modify files or run mutating shell commands. " +
      "Analyze context and produce a clear, decision-complete implementation plan. " +
      "If key information is missing, ask concise structured questions through the request_user_input tool. " +
      "When the plan is final, output it in a <proposed_plan>...</proposed_plan> block and wait for user confirmation before implementation.",
    activeTools: [
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
      "list_mcp_resources",
      "read_mcp_resource",
      "request_user_input",
      "web_search",
    ],
  },
};

export function getCodingAgentModeDefinition(mode: CodingAgentMode): CodingAgentModeDefinition {
  return codingAgentModes[mode];
}

export function cycleCodingAgentMode(currentMode: CodingAgentMode): CodingAgentMode {
  const currentModeIndex = codingAgentModeOrder.indexOf(currentMode);
  const nextModeIndex = (currentModeIndex + 1) % codingAgentModeOrder.length;
  return codingAgentModeOrder[nextModeIndex];
}
