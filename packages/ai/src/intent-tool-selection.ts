import {
  getCodingAgentModeDefinition,
  type CodingAgentMode,
  type CodingAgentToolName,
} from "./coding-agent-modes";

const casualPromptPattern =
  /^(hi|hello|hey|how are you|how r you|what'?s up|whats up|sup|thanks|thank you|ok|okay|yes|no|nice|cool|great)[\s?!.,]*$/i;

/**
 * Safety cap for providers that reject overly large tool grammars. Set above
 * the full tool count (20 names below) so it never drops a legitimate
 * mode tool for capable providers; `limitProviderActiveTools` keeps the
 * priority order so, if a smaller provider ever needs a tighter cap, the core
 * read/write/run tools survive first.
 */
const maxProviderActiveTools = 24;

/** Order in which tools survive the provider cap — core file ops first. */
const providerToolPriority = [
  "list_files",
  "glob_search",
  "read_file",
  "grep",
  "write_file",
  "edit_file",
  "bash",
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
  "web_fetch",
  "web_search",
] as const satisfies readonly CodingAgentToolName[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function collectTextFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(collectTextFromUnknown).filter(Boolean).join("\n");
  }

  if (!isRecord(value)) {
    return "";
  }

  if (typeof value.text === "string") {
    return value.text;
  }

  if (typeof value.content === "string") {
    return value.content;
  }

  if (Array.isArray(value.parts)) {
    return value.parts.map(collectTextFromUnknown).filter(Boolean).join("\n");
  }

  if (Array.isArray(value.content)) {
    return value.content.map(collectTextFromUnknown).filter(Boolean).join("\n");
  }

  return "";
}

function getLastUserText(messages: unknown, prompt: unknown) {
  if (Array.isArray(messages)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!isRecord(message) || message.role !== "user") {
        continue;
      }

      const text = collectTextFromUnknown(message).trim();
      if (text) {
        return text;
      }
    }
  }

  return collectTextFromUnknown(prompt).trim();
}

export function selectCodingAgentIntentTools({
  mode,
  prompt,
  messages,
}: {
  mode: CodingAgentMode;
  prompt: unknown;
  messages: unknown;
  /**
   * Retained for call-site compatibility. Tool exposure no longer depends on
   * skill name matching — every real prompt gets the full mode tool set, which
   * already includes the `skill` tool in build mode.
   */
  availableSkillNames?: readonly string[];
}): CodingAgentToolName[] {
  const userText = getLastUserText(messages, prompt);
  const normalizedText = userText.toLowerCase();

  // Genuine chit-chat ("hi", "thanks") keeps the tool-less fast path. The
  // server's fast-path detector relies on `[]` meaning "no tools needed".
  if (!normalizedText || casualPromptPattern.test(normalizedText)) {
    return [];
  }

  // Every other message is a real task: expose the full set of tools the mode
  // allows and let the model choose (opencode-style). Keyword-guessing a small
  // subset previously dropped write_file/edit_file/bash whenever the prompt
  // happened to mention enough situational tools (git/web), leaving build-mode
  // agents unable to edit files. Plan mode's tool set is read-only by
  // definition, so this stays safe; permission policy is enforced downstream.
  return [...getCodingAgentModeDefinition(mode).activeTools];
}

export function limitProviderActiveTools(
  tools: readonly CodingAgentToolName[],
  maxTools = maxProviderActiveTools,
): CodingAgentToolName[] {
  if (tools.length <= maxTools) {
    return [...tools];
  }

  const toolSet = new Set(tools);

  return providerToolPriority
    .filter((toolName) => toolSet.has(toolName))
    .slice(0, maxTools);
}
