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
  "Use grep for text search and bash for shell commands when file tools are not enough. " +
  "For risky or uncertain operations, inspect context first and be explicit about assumptions. " +
  "While working, emit brief progress notes in natural language before major tool actions and after important findings. " +
  "Keep them short, human, and concrete. Vary wording naturally and avoid repetitive templates or rigid labels.";

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
}: {
  cwd: string;
  override?: string | null;
  mode?: CodingAgentMode;
}) {
  const promptTemplate = override?.trim() ? override : defaultCodingAgentSystemPrompt;
  const normalizedPrompt = normalizePromptTemplate(promptTemplate, cwd);
  const modeDefinition = getCodingAgentModeDefinition(mode);

  return (
    `${normalizedPrompt}\n\n` +
    `Current mode: ${modeDefinition.label}.\n` +
    `Mode purpose: ${modeDefinition.purpose}\n` +
    `${modeDefinition.instructions}`
  );
}
