import {
  type InferAgentUIMessage,
  type LanguageModel,
  stepCountIs,
  ToolLoopAgent,
  tool,
} from "ai";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { createLogger } from "@lightcode/shared";
import {
  type CodingAgentCallOptions,
  codingAgentCallOptionsSchema,
  codingToolDescriptions,
  codingToolProviderInputSchemas,
  getActiveCodingToolsForPolicy,
} from "./agent-tools";
import { buildCodingAgentSystemPrompt } from "./coding-agent-prompt";
import { repairCodingAgentToolCall } from "./coding-agent-tool-repair";
import {
  defaultCodingAgentMode,
  getCodingAgentModeDefinition,
} from "./coding-agent-modes";
import {
  limitProviderActiveTools,
  selectCodingAgentIntentTools,
} from "./intent-tool-selection";

const codingAgentLogger = createLogger("coding-agent");

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
  /** Provider-call retries for transient errors before surfacing them. */
  maxRetries?: number;
  providerOptions?: SharedV3ProviderOptions;
  /** Append tool-calling discipline for models prone to XML/text tool calls. */
  includeToolDiscipline?: boolean;
}

export function createCodingAgent({
  model,
  promptOverride,
  maxOutputTokens = 16384,
  maxSteps = 30,
  maxRetries = 5,
  providerOptions,
  includeToolDiscipline = false,
}: CreateCodingAgentOptions) {
  const tools = createCodingAgentTools();

  return new ToolLoopAgent<CodingAgentCallOptions, typeof tools>({
    model,
    tools,
    stopWhen: stepCountIs(maxSteps),
    maxOutputTokens,
    maxRetries,
    providerOptions,
    // Weak models misname tools or emit malformed argument JSON; repair
    // deterministically instead of failing the step.
    experimental_repairToolCall: repairCodingAgentToolCall,
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

      codingAgentLogger.debug("coding_agent_active_tools", {
        mode,
        requestedTools: policyTools,
        activeTools,
        toolsDisabled: activeTools.length === 0,
      });

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
          includeToolDiscipline,
        }),
      };
    },
  });
}

export type CodingAgentUIMessage = InferAgentUIMessage<ReturnType<typeof createCodingAgent>>;
