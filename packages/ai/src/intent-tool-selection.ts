import type {
  CodingAgentMode,
  CodingAgentToolName,
} from "./coding-agent-modes";

const casualPromptPattern =
  /^(hi|hello|hey|how are you|how r you|what'?s up|whats up|sup|thanks|thank you|ok|okay|yes|no|nice|cool|great)[\s?!.,]*$/i;

const baseReadTools = [
  "list_files",
  "glob_search",
  "read_file",
  "grep",
] as const satisfies readonly CodingAgentToolName[];

/** Providers reject overly large tool grammars; cap the active set. */
const maxProviderActiveTools = 7;

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

function pushUniqueTool(
  tools: CodingAgentToolName[],
  toolName: CodingAgentToolName,
) {
  if (!tools.includes(toolName)) {
    tools.push(toolName);
  }
}

function includesAny(text: string, tokens: readonly string[]) {
  return tokens.some((token) => {
    if (token.includes("://") || token.includes(" ")) {
      return text.includes(token);
    }

    return new RegExp(`(^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(text);
  });
}

export function selectCodingAgentIntentTools({
  mode,
  prompt,
  messages,
}: {
  mode: CodingAgentMode;
  prompt: unknown;
  messages: unknown;
}): CodingAgentToolName[] {
  const userText = getLastUserText(messages, prompt);
  const normalizedText = userText.toLowerCase();

  // Genuine chit-chat ("hi", "thanks") keeps the tool-less fast path. Every
  // other message is a real task and MUST get tools — gating tool availability
  // on keyword matches previously returned [] for prompts like "design a
  // multiplayer system", leaving the model with no tools and a hard
  // NoSuchToolError the moment it tried to read a file.
  if (!normalizedText || casualPromptPattern.test(normalizedText)) {
    return [];
  }

  // Situational tools are niche and added only on explicit intent — they must
  // not crowd the core set out from under the provider tool cap, so they are
  // placed after the always-on read tools but before the build-mode defaults.
  const situational: CodingAgentToolName[] = [];

  const hasGitIntent = includesAny(normalizedText, [
    "git",
    "diff",
    "status",
    "commit",
    "log",
    "show",
    "revision",
    "changes",
  ]);
  if (hasGitIntent) {
    if (
      includesAny(normalizedText, ["status", "state", "dirty", "working tree"]) ||
      !includesAny(normalizedText, ["diff", "log", "show", "history", "commit"])
    ) {
      pushUniqueTool(situational, "git_status");
    }
    if (includesAny(normalizedText, ["diff", "changes", "patch"])) {
      pushUniqueTool(situational, "git_diff");
    }
    if (includesAny(normalizedText, ["log", "history", "commits"])) {
      pushUniqueTool(situational, "git_log");
    }
    if (includesAny(normalizedText, ["show", "revision", "commit"])) {
      pushUniqueTool(situational, "git_show");
    }
  }

  if (
    mode === "build" &&
    includesAny(normalizedText, ["todo", "tasks", "checklist", "steps", "epic", "ticket"])
  ) {
    pushUniqueTool(situational, "todo_write");
  }

  if (includesAny(normalizedText, ["tool_search", "tool search", "find tool", "available tool"])) {
    pushUniqueTool(situational, "tool_search");
  }

  if (includesAny(normalizedText, ["skill", "skills", "load skill"])) {
    pushUniqueTool(situational, "skill");
  }

  if (includesAny(normalizedText, ["mcp", "resource", "resources", "mcp tool", "mcp server"])) {
    pushUniqueTool(situational, "list_mcp_resources");
    if (includesAny(normalizedText, ["read", "resource", "resources"])) {
      pushUniqueTool(situational, "read_mcp_resource");
    }
    if (mode === "build" && includesAny(normalizedText, ["call", "execute", "run"])) {
      pushUniqueTool(situational, "call_mcp_tool");
    }
  }

  if (
    includesAny(normalizedText, [
      "http://",
      "https://",
      "url",
      "fetch",
      "website",
      "web",
      "online",
      "search internet",
      "latest",
    ])
  ) {
    pushUniqueTool(situational, "web_fetch");
    pushUniqueTool(situational, "web_search");
  }

  if (mode === "plan" && includesAny(normalizedText, ["question", "ask", "clarify"])) {
    pushUniqueTool(situational, "request_user_input");
  }

  // Compose the active set, ordered by what must survive the provider cap:
  //   1. core read tools — every task can inspect the workspace (the fix);
  //   2. explicit situational tools — honor what the user asked for;
  //   3. build-mode write/run defaults — so a build task can edit and run
  //      without the user re-phrasing (plan mode is read-only and skips these).
  const ordered: CodingAgentToolName[] = [...baseReadTools, ...situational];
  if (mode === "build") {
    ordered.push("write_file", "edit_file", "bash");
  }

  const selected: CodingAgentToolName[] = [];
  for (const toolName of ordered) {
    pushUniqueTool(selected, toolName);
  }

  // Cap here (read-first order preserved) so the downstream priority-based cap
  // can't reorder and drop the read tools or the explicitly-requested ones.
  return selected.slice(0, maxProviderActiveTools);
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
