import { InvalidToolInputError, NoSuchToolError } from "ai";
import type { LanguageModelV3ToolCall } from "@ai-sdk/provider";
import { codingToolProviderInputSchemas } from "./agent-tools";
import { coerceToolInputToSchema } from "./common/coerce-tool-input";
import { repairToolJson } from "./providers/tool-call-json-repair";

/**
 * Deterministic repair for tool calls from weaker models: near-miss tool
 * names are mapped to the real tool, malformed argument JSON is healed.
 * No extra LLM calls are made — unrepairable calls return null and surface
 * as ordinary tool errors.
 */

const toolNameAliases: Record<string, string> = {
  read: "read_file",
  cat: "read_file",
  open_file: "read_file",
  view_file: "read_file",
  write: "write_file",
  create_file: "write_file",
  save_file: "write_file",
  edit: "edit_file",
  str_replace: "edit_file",
  str_replace_editor: "edit_file",
  apply_patch: "edit_file",
  search: "grep",
  grep_search: "grep",
  ripgrep: "grep",
  text_search: "grep",
  ls: "list_files",
  list: "list_files",
  list_dir: "list_files",
  list_directory: "list_files",
  glob: "glob_search",
  find: "glob_search",
  find_files: "glob_search",
  file_search: "glob_search",
  shell: "bash",
  run_command: "bash",
  execute_command: "bash",
  run_shell_command: "bash",
  terminal: "bash",
  exec: "bash",
  todo: "todo_write",
  todowrite: "todo_write",
  update_todos: "todo_write",
  fetch: "web_fetch",
  webfetch: "web_fetch",
  fetch_url: "web_fetch",
  websearch: "web_search",
  search_web: "web_search",
};

function normalizeToolName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, "_")
    .replace(/^functions?[._]/, "");
}

function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = temp;
    }
  }
  return dp[b.length];
}

/**
 * Maps a misnamed tool to an available one. Returns null when no confident
 * match exists.
 */
export function repairToolName(
  toolName: string,
  availableTools: readonly string[],
): string | null {
  const normalized = normalizeToolName(toolName);

  if (availableTools.includes(normalized)) {
    return normalized;
  }

  const alias = toolNameAliases[normalized];
  if (alias && availableTools.includes(alias)) {
    return alias;
  }

  let best: { name: string; distance: number } | null = null;
  for (const candidate of availableTools) {
    const distance = editDistance(normalized, candidate);
    if (distance <= 2 && (best === null || distance < best.distance)) {
      best = { name: candidate, distance };
    }
  }
  return best?.name ?? null;
}

/**
 * `experimental_repairToolCall` implementation for the coding agent.
 */
export async function repairCodingAgentToolCall({
  toolCall,
  tools,
  error,
}: {
  toolCall: LanguageModelV3ToolCall;
  tools: Record<string, unknown>;
  error: NoSuchToolError | InvalidToolInputError;
}): Promise<LanguageModelV3ToolCall | null> {
  const availableTools = Object.keys(tools);

  if (NoSuchToolError.isInstance(error)) {
    const repairedName = repairToolName(toolCall.toolName, availableTools);
    if (!repairedName) {
      return null;
    }
    return {
      ...toolCall,
      toolName: repairedName,
    };
  }

  if (InvalidToolInputError.isInstance(error)) {
    const repairedInput = await repairToolJson(toolCall.input);
    if (!repairedInput || typeof repairedInput !== "object") {
      return null;
    }
    // Heal wrong-typed primitives (e.g. "10" -> 10) against the tool's schema so
    // weaker models clear validation; fall back to the syntax-only repair.
    const schema =
      codingToolProviderInputSchemas[
        toolCall.toolName as keyof typeof codingToolProviderInputSchemas
      ];
    const coerced = schema
      ? coerceToolInputToSchema(repairedInput, schema)
      : null;
    return {
      ...toolCall,
      input: JSON.stringify(coerced ?? repairedInput),
    };
  }

  return null;
}
