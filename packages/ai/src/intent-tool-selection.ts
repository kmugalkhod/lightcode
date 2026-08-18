import {
  codingAgentToolNameSchema,
  type CodingAgentMode,
  type CodingAgentToolName,
} from "./coding-agent-modes";
import {
  codingToolRegistry,
  getRegistryToolsForMode,
} from "./tool-registry";

const casualPromptPattern =
  /^(hi|hello|hey|how are you|how r you|what'?s up|whats up|sup|thanks|thank you|ok|okay|yes|no|nice|cool|great)[\s?!.,]*$/i;

const gitIntentPattern =
  /(?:\bgit\b|\bcommits?\b|\bstaged?\b|\bunstaged\b|\buntracked\b|\bworking tree\b|\brepositor(?:y|ies)\s+(?:status|diff|history|changes))/i;
const webIntentPattern =
  /(?:\bhttps?:\/\/|\bwww\.|\bweb(?:site|page)?\b|\binternet\b|\bonline\b|\burl\b|\bbrowser\b|\bsearch\s+(?:the\s+)?web\b|\bbrowse\s+(?:the\s+web|online|for)\b|\blook\s+up\b|\b(?:latest|current|recent|today'?s)\s+(?:news|price|weather|docs?|documentation|release|version)\b)/i;
const mcpIntentPattern = /(?:\bmcp\b|\bmodel context protocol\b)/i;
const skillIntentPattern = /\bskills?\b/i;

const gitToolNames = [
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
] as const satisfies readonly CodingAgentToolName[];
const webToolNames = [
  "web_fetch",
  "web_search",
] as const satisfies readonly CodingAgentToolName[];
const mcpToolNames = [
  "list_mcp_resources",
  "read_mcp_resource",
  "call_mcp_tool",
] as const satisfies readonly CodingAgentToolName[];

/**
 * Safety cap for providers that reject overly large tool grammars. It is above
 * the complete registry today; a lower caller-supplied cap retains core file,
 * edit, shell, and discovery tools before specialized schemas.
 */
const maxProviderActiveTools = 24;

/** Order in which tools survive a provider cap — registry core tools first. */
const providerToolPriority = [
  "agent",
  "list_files",
  "glob_search",
  "read_file",
  "grep",
  "write_file",
  "edit_file",
  "bash",
  "tool_search",
  "request_user_input",
  "todo_write",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "skill",
  "list_mcp_resources",
  "read_mcp_resource",
  "call_mcp_tool",
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requestsAvailableSkill(
  userText: string,
  availableSkillNames: readonly string[],
) {
  return availableSkillNames.some((rawName) => {
    const name = rawName.trim();
    if (!name) {
      return false;
    }

    const escapedName = escapeRegExp(name);
    return new RegExp(
      `(?:\\$${escapedName}(?:\\b|$)|\\b(?:use|load|apply|run|invoke)\\s+(?:the\\s+)?${escapedName}(?:\\s+skill)?\\b)`,
      "i",
    ).test(userText);
  });
}

function addTools(
  selected: Set<CodingAgentToolName>,
  names: readonly CodingAgentToolName[],
) {
  for (const name of names) {
    selected.add(name);
  }
}

/**
 * Select a compact first-step grammar. Every real task gets all mode-allowed
 * registry `core` tools, while larger Git, web, MCP, and skill schemas are
 * included only when the latest user request clearly asks for that capability.
 * `tool_search` remains core so a model can discover a specialized tool during
 * the loop without paying for every specialized schema up front.
 */
export function selectCodingAgentIntentTools({
  mode,
  prompt,
  messages,
  availableSkillNames = [],
}: {
  mode: CodingAgentMode;
  prompt: unknown;
  messages: unknown;
  availableSkillNames?: readonly string[];
}): CodingAgentToolName[] {
  const userText = getLastUserText(messages, prompt);
  const normalizedText = userText.toLowerCase();

  // Genuine chit-chat ("hi", "thanks") keeps the tool-less fast path.
  if (!normalizedText || casualPromptPattern.test(normalizedText)) {
    return [];
  }

  const modeTools = getRegistryToolsForMode(mode);
  const selected = new Set<CodingAgentToolName>(
    modeTools.filter(
      (toolName) => codingToolRegistry[toolName].activation === "core",
    ),
  );

  if (gitIntentPattern.test(userText)) {
    addTools(selected, gitToolNames);
  }
  if (webIntentPattern.test(userText)) {
    addTools(selected, webToolNames);
  }
  if (mcpIntentPattern.test(userText)) {
    addTools(selected, mcpToolNames);
  }
  if (
    skillIntentPattern.test(userText) ||
    requestsAvailableSkill(userText, availableSkillNames)
  ) {
    selected.add("skill");
  }

  // Registry order is deterministic, cache-friendly, and also removes any
  // specialized tool that is not allowed by the active mode.
  return modeTools.filter((toolName) => selected.has(toolName));
}

function getMessageParts(message: unknown): readonly unknown[] {
  if (!isRecord(message)) {
    return [];
  }

  if (Array.isArray(message.parts)) {
    return message.parts;
  }

  if (Array.isArray(message.content)) {
    return message.content;
  }

  return [];
}

function isCompletedToolSearchPart(part: unknown): part is Record<string, unknown> {
  if (!isRecord(part)) {
    return false;
  }

  // AI SDK ModelMessage tool results are complete by construction.
  if (part.type === "tool-result") {
    return part.toolName === "tool_search";
  }

  // AI SDK UIMessage uses either a static `tool-${name}` part or a dynamic
  // tool part. Only consume the terminal success state, never streaming,
  // approval, denied, or error parts.
  const isStaticToolSearch = part.type === "tool-tool_search";
  const isDynamicToolSearch =
    part.type === "dynamic-tool" && part.toolName === "tool_search";
  return (
    (isStaticToolSearch || isDynamicToolSearch) &&
    part.state === "output-available"
  );
}

function unwrapToolSearchOutput(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  if ((value.type === "json" || value.type === "text") && "value" in value) {
    if (value.type === "text" && typeof value.value === "string") {
      try {
        return JSON.parse(value.value) as unknown;
      } catch {
        return null;
      }
    }
    return value.value;
  }

  return value;
}

function collectNamesFromToolSearchOutput(
  value: unknown,
  discovered: Set<CodingAgentToolName>,
) {
  const output = unwrapToolSearchOutput(value);
  if (!isRecord(output) || !Array.isArray(output.results)) {
    return;
  }

  for (const result of output.results) {
    if (!isRecord(result)) {
      continue;
    }

    const parsedName = codingAgentToolNameSchema.safeParse(result.name);
    if (parsedName.success) {
      discovered.add(parsedName.data);
    }
  }
}

/**
 * Read completed `tool_search` results from AI SDK ModelMessages or UI-like
 * messages. The returned set is schema-validated, de-duplicated, deterministic,
 * and constrained to tools permitted by the active mode. It is deliberately
 * pure so `prepareStep` can merge discoveries into the next provider request.
 */
export function collectToolSearchDiscoveredTools({
  messages,
  mode,
}: {
  messages: readonly unknown[];
  mode: CodingAgentMode;
}): CodingAgentToolName[] {
  const discovered = new Set<CodingAgentToolName>();

  for (const message of messages) {
    for (const part of getMessageParts(message)) {
      if (isCompletedToolSearchPart(part)) {
        collectNamesFromToolSearchOutput(part.output, discovered);
      }
    }
  }

  return getRegistryToolsForMode(mode).filter((toolName) =>
    discovered.has(toolName),
  );
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
