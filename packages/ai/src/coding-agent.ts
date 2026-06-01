import {
  type InferAgentUIMessage,
  type LanguageModel,
  stepCountIs,
  ToolLoopAgent,
  tool,
} from "ai";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import {
  type CodingAgentCallOptions,
  codingAgentCallOptionsSchema,
  codingToolDescriptions,
  codingToolProviderInputSchemas,
  getActiveCodingToolsForPolicy,
} from "./agent-tools";
import { buildCodingAgentSystemPrompt } from "./coding-agent-prompt";
import {
  defaultCodingAgentMode,
  getCodingAgentModeDefinition,
  type CodingAgentToolName,
  type CodingAgentMode,
} from "./coding-agent-modes";

const casualPromptPattern =
  /^(hi|hello|hey|how are you|how r you|what'?s up|whats up|sup|thanks|thank you|ok|okay|yes|no|nice|cool|great)[\s?!.,]*$/i;

const baseReadTools = [
  "list_files",
  "glob_search",
  "read_file",
  "grep",
] as const satisfies readonly CodingAgentToolName[];
const maxProviderActiveTools = 7;
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
  const hasWriteIntent =
    mode === "build" &&
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
    ]);
  const hasShellIntent =
    mode === "build" &&
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
    ]);
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

export function createCodingAgentTools() {
  return {
    list_files: tool({
      description: codingToolDescriptions.list_files,
      inputSchema: codingToolProviderInputSchemas.list_files,
      strict: true,
    }),
    glob_search: tool({
      description: codingToolDescriptions.glob_search,
      inputSchema: codingToolProviderInputSchemas.glob_search,
      strict: true,
    }),
    read_file: tool({
      description: codingToolDescriptions.read_file,
      inputSchema: codingToolProviderInputSchemas.read_file,
      strict: true,
    }),
    grep: tool({
      description: codingToolDescriptions.grep,
      inputSchema: codingToolProviderInputSchemas.grep,
      strict: true,
    }),
    git_status: tool({
      description: codingToolDescriptions.git_status,
      inputSchema: codingToolProviderInputSchemas.git_status,
      strict: true,
    }),
    git_diff: tool({
      description: codingToolDescriptions.git_diff,
      inputSchema: codingToolProviderInputSchemas.git_diff,
      strict: true,
    }),
    git_log: tool({
      description: codingToolDescriptions.git_log,
      inputSchema: codingToolProviderInputSchemas.git_log,
      strict: true,
    }),
    git_show: tool({
      description: codingToolDescriptions.git_show,
      inputSchema: codingToolProviderInputSchemas.git_show,
      strict: true,
    }),
    tool_search: tool({
      description: codingToolDescriptions.tool_search,
      inputSchema: codingToolProviderInputSchemas.tool_search,
      strict: true,
    }),
    skill: tool({
      description: codingToolDescriptions.skill,
      inputSchema: codingToolProviderInputSchemas.skill,
      strict: true,
    }),
    list_mcp_resources: tool({
      description: codingToolDescriptions.list_mcp_resources,
      inputSchema: codingToolProviderInputSchemas.list_mcp_resources,
      strict: true,
    }),
    read_mcp_resource: tool({
      description: codingToolDescriptions.read_mcp_resource,
      inputSchema: codingToolProviderInputSchemas.read_mcp_resource,
      strict: true,
    }),
    call_mcp_tool: tool({
      description: codingToolDescriptions.call_mcp_tool,
      inputSchema: codingToolProviderInputSchemas.call_mcp_tool,
      strict: true,
    }),
    request_user_input: tool({
      description: codingToolDescriptions.request_user_input,
      inputSchema: codingToolProviderInputSchemas.request_user_input,
      strict: true,
    }),
    todo_write: tool({
      description: codingToolDescriptions.todo_write,
      inputSchema: codingToolProviderInputSchemas.todo_write,
      strict: true,
    }),
    write_file: tool({
      description: codingToolDescriptions.write_file,
      inputSchema: codingToolProviderInputSchemas.write_file,
      strict: true,
    }),
    edit_file: tool({
      description: codingToolDescriptions.edit_file,
      inputSchema: codingToolProviderInputSchemas.edit_file,
      strict: true,
    }),
    bash: tool({
      description: codingToolDescriptions.bash,
      inputSchema: codingToolProviderInputSchemas.bash,
      strict: true,
    }),
    web_fetch: tool({
      description: codingToolDescriptions.web_fetch,
      inputSchema: codingToolProviderInputSchemas.web_fetch,
      strict: true,
    }),
    web_search: tool({
      description: codingToolDescriptions.web_search,
      inputSchema: codingToolProviderInputSchemas.web_search,
      strict: true,
    }),
  };
}

export type CodingAgentTools = ReturnType<typeof createCodingAgentTools>;

export interface CreateCodingAgentOptions {
  model: LanguageModel;
  promptOverride?: string | null;
  maxOutputTokens?: number;
  maxSteps?: number;
  providerOptions?: SharedV3ProviderOptions;
}

export function createCodingAgent({
  model,
  promptOverride,
  maxOutputTokens = 10000,
  maxSteps = 10,
  providerOptions,
}: CreateCodingAgentOptions) {
  const tools = createCodingAgentTools();

  return new ToolLoopAgent<CodingAgentCallOptions, typeof tools>({
    model,
    tools,
    stopWhen: stepCountIs(maxSteps),
    maxOutputTokens,
    providerOptions,
    callOptionsSchema: codingAgentCallOptionsSchema,
    prepareCall: ({ options, prompt, messages, ...settings }) => {
      const mode = options.mode ?? defaultCodingAgentMode;
      const modeDefinition = getCodingAgentModeDefinition(mode);
      const intentTools = selectCodingAgentIntentTools({
        mode,
        prompt,
        messages,
      });
      const policyTools = getActiveCodingToolsForPolicy({
        modeTools: intentTools.filter((toolName) =>
          modeDefinition.activeTools.includes(toolName),
        ),
        mode,
        permissionMode: options.permissionMode,
        allowedTools: options.allowedTools,
        permissionRules: options.permissionRules,
      });
      const activeTools = limitProviderActiveTools(policyTools);

      console.log(
        JSON.stringify({
          event: "coding_agent_active_tools",
          mode,
          requestedTools: policyTools,
          activeTools,
          toolsDisabled: activeTools.length === 0,
        }),
      );

      return {
        ...settings,
        prompt,
        messages,
        tools: activeTools.length > 0 ? settings.tools : undefined,
        activeTools: activeTools.length > 0 ? activeTools : undefined,
        instructions: buildCodingAgentSystemPrompt({
          cwd: options.cwd,
          override: promptOverride,
          mode,
        }),
      };
    },
  });
}

export type CodingAgentUIMessage = InferAgentUIMessage<ReturnType<typeof createCodingAgent>>;
