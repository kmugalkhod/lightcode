import { z } from "zod";

const codingAgentToolNameOrder = [
  "list_files",
  "read_file",
  "grep",
  "request_user_input",
  "write_file",
  "edit_file",
  "bash",
] as const;

export type CodingAgentToolName = (typeof codingAgentToolNameOrder)[number];

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
    activeTools: ["list_files", "read_file", "grep", "write_file", "edit_file", "bash"],
  },
  plan: {
    label: "Plan",
    purpose: "Read-only planning mode focused on safe analysis and implementation design.",
    instructions:
      "You are in plan mode (safe read-only mode). Do not attempt to modify files or run mutating shell commands. " +
      "Analyze context and produce a clear, decision-complete implementation plan. " +
      "If key information is missing, ask concise structured questions through the request_user_input tool. " +
      "When the plan is final, output it in a <proposed_plan>...</proposed_plan> block and wait for user confirmation before implementation.",
    activeTools: ["list_files", "read_file", "grep", "request_user_input"],
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
