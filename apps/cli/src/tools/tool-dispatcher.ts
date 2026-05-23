import {
  codingToolInputSchemas,
  executeCodingTool as executeCodingToolRuntime,
  riskyCodingTools,
  type CodingToolName,
  toSingleLinePreview,
} from "@lightcode/tools/runtime";

const riskyToolNameSet = new Set<string>(riskyCodingTools);
const codingToolNameSet = new Set<string>(Object.keys(codingToolInputSchemas));

export interface PendingToolApproval {
  toolCallId: string;
  toolName: CodingToolName;
  input: unknown;
  summary: string;
}

export function isCodingToolName(toolName: string): toolName is CodingToolName {
  return codingToolNameSet.has(toolName);
}

export function isRiskyToolName(toolName: CodingToolName): boolean {
  return riskyToolNameSet.has(toolName);
}

export function summarizeToolCall(toolName: CodingToolName, input: unknown): string {
  return `${toolName} ${toSingleLinePreview(input)}`.trim();
}

export async function executeCodingTool(toolName: CodingToolName, rawInput: unknown): Promise<unknown> {
  return executeCodingToolRuntime(toolName, rawInput);
}
