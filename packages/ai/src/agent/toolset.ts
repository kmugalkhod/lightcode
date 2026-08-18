import { tool, type ToolSet } from "ai";
import type { z } from "zod";
import {
  codingToolDescriptions,
  codingToolProviderInputSchemas,
} from "../agent-tools";
import {
  executeCodingTool,
  type CodingToolExecutionOptions,
} from "../runtime-registry";
import {
  subagentProfileTools,
  SUBAGENT_SUMMARY_TOKEN_CAP,
  type SubagentProfile,
} from "../subagent-schemas";

/**
 * Tools for a subagent loop, with execute functions wired straight to the
 * local runtimes. Unlike the parent agent (whose tool calls are streamed to
 * the client for execution), a subagent runs entirely inside one process, so
 * its loop can execute tools inline. Every profile is read-only and the
 * permission policy is enforced on each call, so a subagent can never exceed
 * its parent's permissions (LC-054).
 */
export function createSubagentToolset(
  profile: SubagentProfile,
  { cwd }: { cwd: string },
): ToolSet {
  const executionOptions: CodingToolExecutionOptions = {
    mode: "plan",
    permissionMode: "read-only",
    allowedTools: subagentProfileTools[profile],
    cwd,
    // Fresh key per subagent run so the repeat-call guard is scoped to this
    // loop instead of sharing state with the parent turn.
    turnKey: crypto.randomUUID(),
  };

  const toolset: ToolSet = {};
  for (const toolName of subagentProfileTools[profile]) {
    // Indexing the schema map by a runtime key erases the per-tool relation,
    // so widen to an untyped schema; executeCodingTool re-validates anyway.
    const inputSchema = codingToolProviderInputSchemas[
      toolName
    ] as z.ZodType<unknown>;
    toolset[toolName] = tool({
      description: codingToolDescriptions[toolName],
      inputSchema,
      strict: true,
      execute: (input, { abortSignal }) =>
        executeCodingTool(toolName, input as never, {
          ...executionOptions,
          abortSignal,
        }),
    });
  }

  return toolset;
}

export function buildSubagentSystemPrompt({
  profile,
  cwd,
}: {
  profile: SubagentProfile;
  cwd: string;
}): string {
  return (
    `You are a read-only ${profile} subagent working inside the user's project at this working directory: ${cwd}. ` +
    "You were spawned by a parent coding agent to investigate the codebase and report back. " +
    "You cannot modify files or run shell commands — use the provided read-only tools (list_files, glob_search, grep, read_file, git tools) to answer the task. " +
    "Work autonomously: never ask questions, and stop as soon as you can answer confidently.\n\n" +
    "Your FINAL message is the ONLY thing returned to the parent agent — intermediate notes and tool outputs are discarded. " +
    "Make it a self-contained report: state your conclusions first, ground every claim in specific file paths and line numbers, " +
    "and include short code excerpts only when essential. " +
    `Keep the report under ~${SUBAGENT_SUMMARY_TOKEN_CAP} tokens; anything longer is truncated.`
  );
}
