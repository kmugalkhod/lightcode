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

  if (!normalizedText || casualPromptPattern.test(normalizedText)) {
    return [];
  }

  const selectedTools: CodingAgentToolName[] = [];
  // Terse continuations carry no code keywords but mean "keep doing the work".
  const hasContinuationIntent = includesAny(normalizedText, [
    "continue",
    "proceed",
    "go on",
    "go ahead",
    "keep going",
    "carry on",
    "resume",
    "finish",
    "next step",
  ]);
  const hasCodeIntent = includesAny(normalizedText, [
    "file",
    "folder",
    "code",
    "repo",
    "project",
    "implement",
    "fix",
    "add",
    "build",
    "refactor",
    "change",
    "create",
    "update",
    "edit",
    "delete",
    "run",
    "test",
    "typecheck",
    "debug",
    "error",
    "issue",
    "problem",
    "fails",
    "failed",
    "failing",
    "bug",
    "crash",
    "slow",
    "slowness",
    "not working",
    "epic",
    "ticket",
  ]);
  const hasReadIntent = includesAny(normalizedText, [
    "read",
    "list",
    "find",
    "search",
    "grep",
    "glob",
    "inspect",
    "analyse",
    "analyze",
    "check",
  ]);
  // Exploration/review requests carry no code keyword but should still read the
  // workspace ("review this", "explain the code", "look at this project").
  // "review"/"audit"/"walk through" imply the codebase on their own; softer
  // verbs ("explain", "summarize", ...) only do so when paired with a workspace
  // referent, so "explain recursion in simple words" stays a plain Q&A.
  const workspaceReferents = [
    "this",
    "these",
    "that",
    "here",
    "code",
    "codebase",
    "repo",
    "repository",
    "project",
    "file",
    "files",
    "directory",
    "folder",
    "app",
    "application",
    "module",
    "my",
  ];
  const strongReviewIntent = includesAny(normalizedText, [
    "review",
    "audit",
    "walk through",
    "walkthrough",
    "code review",
  ]);
  const softReviewIntent =
    includesAny(normalizedText, [
      "explain",
      "understand",
      "summarize",
      "summarise",
      "overview",
      "describe",
      "explore",
      "look at",
    ]) && includesAny(normalizedText, workspaceReferents);
  const hasReviewIntent = strongReviewIntent || softReviewIntent;
  const hasWriteIntent =
    mode === "build" &&
    (hasContinuationIntent ||
      includesAny(normalizedText, [
        "write",
        "edit",
        "change",
        "create",
        "implement",
        "fix",
        "update",
        "delete",
        "remove",
        "rename",
      ]));
  const hasShellIntent =
    mode === "build" &&
    (hasContinuationIntent ||
      includesAny(normalizedText, [
        "run",
        "command",
        "terminal",
        "shell",
        "bash",
        "powershell",
        "bun",
        "tests",
        "run test",
        "run tests",
        "typecheck",
      ]));
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
  const hasTodoIntent = includesAny(normalizedText, [
    "todo",
    "tasks",
    "checklist",
    "steps",
    "epic",
    "ticket",
  ]);
  const hasWebIntent = includesAny(normalizedText, [
    "http://",
    "https://",
    "url",
    "fetch",
    "website",
    "web",
    "online",
    "search internet",
    "latest",
  ]);
  const explicitToolSearch = includesAny(normalizedText, [
    "tool_search",
    "tool search",
    "find tool",
    "available tool",
  ]);
  const hasSkillIntent = includesAny(normalizedText, [
    "skill",
    "skills",
    "load skill",
  ]);
  const hasMcpIntent = includesAny(normalizedText, [
    "mcp",
    "resource",
    "resources",
    "mcp tool",
    "mcp server",
  ]);

  if (
    hasCodeIntent ||
    hasContinuationIntent ||
    hasReviewIntent ||
    (hasReadIntent && !hasGitIntent && !hasWebIntent && !explicitToolSearch)
  ) {
    for (const toolName of baseReadTools) {
      pushUniqueTool(selectedTools, toolName);
    }
  }

  if (hasGitIntent) {
    if (
      includesAny(normalizedText, ["status", "state", "dirty", "working tree"]) ||
      !includesAny(normalizedText, ["diff", "log", "show", "history", "commit"])
    ) {
      pushUniqueTool(selectedTools, "git_status");
    }

    if (includesAny(normalizedText, ["diff", "changes", "patch"])) {
      pushUniqueTool(selectedTools, "git_diff");
    }

    if (includesAny(normalizedText, ["log", "history", "commits"])) {
      pushUniqueTool(selectedTools, "git_log");
    }

    if (includesAny(normalizedText, ["show", "revision", "commit"])) {
      pushUniqueTool(selectedTools, "git_show");
    }
  }

  if (hasTodoIntent && mode === "build") {
    pushUniqueTool(selectedTools, "todo_write");
  }

  if (explicitToolSearch) {
    pushUniqueTool(selectedTools, "tool_search");
  }

  if (hasSkillIntent) {
    pushUniqueTool(selectedTools, "skill");
  }

  if (hasMcpIntent) {
    pushUniqueTool(selectedTools, "list_mcp_resources");
    if (includesAny(normalizedText, ["read", "resource", "resources"])) {
      pushUniqueTool(selectedTools, "read_mcp_resource");
    }
    if (mode === "build" && includesAny(normalizedText, ["call", "execute", "run"])) {
      pushUniqueTool(selectedTools, "call_mcp_tool");
    }
  }

  if (hasWriteIntent) {
    pushUniqueTool(selectedTools, "write_file");
    pushUniqueTool(selectedTools, "edit_file");
  }

  if (hasShellIntent) {
    pushUniqueTool(selectedTools, "bash");
  }

  if (hasWebIntent) {
    pushUniqueTool(selectedTools, "web_fetch");
    pushUniqueTool(selectedTools, "web_search");
  }

  if (mode === "plan" && includesAny(normalizedText, ["question", "ask", "clarify"])) {
    pushUniqueTool(selectedTools, "request_user_input");
  }

  return selectedTools;
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
