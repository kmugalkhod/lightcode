import {
  defaultCodingAgentMode,
  getCodingAgentModeDefinition,
  type CodingAgentMode,
} from "./coding-agent-modes";

export const cwdPromptPlaceholder = "{cwd}";

export const defaultCodingAgentSystemPrompt =
  "You are a basic coding agent. Use tools for filesystem and codebase tasks instead of guessing. " +
  "Respect the user's intent, explain changes clearly, and prefer incremental, auditable actions. " +
  "You can only interact with files under this working directory: {cwd}. " +
  "Use glob_search for path discovery, grep for text search, structured git tools for repository inspection, and bash only when dedicated tools are not enough. " +
  "Use todo_write to keep multi-step implementation work visible and current. " +
  "For risky or uncertain operations, inspect context first and be explicit about assumptions. " +
  "While working, emit brief progress notes in natural language before major tool actions and after important findings. " +
  "Keep them short, human, and concrete. Vary wording naturally and avoid repetitive templates or rigid labels.\n\n" +
  "You are an agent — keep working until the user's request is fully resolved before ending your turn. " +
  "Never stop with a partial answer. If you say you will do something, do it in the same turn by calling a tool. " +
  "Use todo_write to track multi-step work and do not finish while any todo is pending or in_progress. " +
  "Only end your turn when the task is complete or you are blocked on input that only the user can provide.";

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
}: {
  cwd: string;
  override?: string | null;
  mode?: CodingAgentMode;
  /** Append tool-calling discipline for models prone to XML tool calls. */
  includeToolDiscipline?: boolean;
}) {
  const promptTemplate = override?.trim() ? override : defaultCodingAgentSystemPrompt;
  const normalizedPrompt = normalizePromptTemplate(promptTemplate, cwd);
  const modeDefinition = getCodingAgentModeDefinition(mode);

  return (
    `${normalizedPrompt}\n\n` +
    `Current mode: ${modeDefinition.label}.\n` +
    `Mode purpose: ${modeDefinition.purpose}\n` +
    `${modeDefinition.instructions}` +
    (includeToolDiscipline ? `\n\n${toolCallingDisciplineAddendum}` : "")
  );
}
