import {
  defaultCodingAgentMode,
  getCodingAgentModeDefinition,
  type CodingAgentMode,
} from "./coding-agent-modes";

export const cwdPromptPlaceholder = "{cwd}";

export const defaultCodingAgentSystemPrompt =
  "You are a coding agent working inside the user's project at this working directory: {cwd}. " +
  "You can already see the project — proactively read it. When the user asks you to review, explain, or work on \"my code\"/\"this\", inspect the working directory yourself with list_files, glob_search, grep, and read_file; NEVER ask the user to paste or share code that lives in this directory — open it. " +
  "Use tools for filesystem and codebase tasks instead of guessing, and only interact with files under the working directory. " +
  "Prefer dedicated tools — glob_search for paths, grep for text search, structured git tools for repository inspection — and bash only when those are not enough. " +
  "Use todo_write to keep multi-step work visible and current, inspect context before risky operations, and emit a brief, natural progress note before major tool actions and after important findings.\n\n" +
  "You are an agent — keep working until the request is fully resolved. Never stop with a partial answer; if you say you will do something, do it in the same turn by calling a tool. Do not finish while any todo is pending or in_progress — end your turn only when the task is complete or you are blocked on input that only the user can provide.\n\n" +
  "Long-running processes (dev servers, watchers): never run them as plain foreground bash — the bash tool enforces a timeout and will kill them. Start them detached with output redirected to a log " +
  "(Windows: start /B cmd /c \"npm run dev > dev.log 2>&1\"; Unix: nohup npm run dev > dev.log 2>&1 &), then read the log to confirm startup and the actual port (do not assume the default). " +
  "Never kill processes or free ports you did not open yourself.";

/**
 * Extra tool-calling discipline for models that tend to emit tool calls as
 * XML/plain text (e.g. MiniMax, DeepSeek behind OpenAI-compatible endpoints).
 */
export const toolCallingDisciplineAddendum =
  "Invoke tools only through the function-calling interface. " +
  "Never write tool calls as XML or plain text such as <tool_call>, <function_call>, <invoke>, or bare JSON in your message. " +
  "Tool arguments must be valid JSON matching the tool's schema. " +
  "Call one tool at a time and wait for its result before deciding the next step.";

function normalizePromptTemplate(template: string, cwd: string) {
  if (template.includes(cwdPromptPlaceholder)) {
    return template.replaceAll(cwdPromptPlaceholder, cwd);
  }

  return `${template.trim()} Working directory: ${cwd}.`;
}

export function buildCodingAgentSystemPrompt({
  cwd,
  override,
  mode = defaultCodingAgentMode,
  includeToolDiscipline = false,
  environmentContext,
}: {
  cwd: string;
  override?: string | null;
  mode?: CodingAgentMode;
  /** Append tool-calling discipline for models prone to XML tool calls. */
  includeToolDiscipline?: boolean;
  /** Per-turn workspace snapshot (cwd, git, listing, project docs). */
  environmentContext?: string | null;
}) {
  const promptTemplate = override?.trim() ? override : defaultCodingAgentSystemPrompt;
  const normalizedPrompt = normalizePromptTemplate(promptTemplate, cwd);
  const modeDefinition = getCodingAgentModeDefinition(mode);

  return (
    `${normalizedPrompt}\n\n` +
    `Current mode: ${modeDefinition.label}.\n` +
    `Mode purpose: ${modeDefinition.purpose}\n` +
    `${modeDefinition.instructions}` +
    (includeToolDiscipline ? `\n\n${toolCallingDisciplineAddendum}` : "") +
    (environmentContext?.trim() ? `\n\n${environmentContext.trim()}` : "")
  );
}
