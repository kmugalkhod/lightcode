import {
  type InferAgentUIMessage,
  type LanguageModel,
  stepCountIs,
  ToolLoopAgent,
  tool,
} from "ai";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import {
  codingAgentCallOptionsSchema,
  codingToolDescriptions,
  codingToolProviderInputSchemas,
} from "./agent-tools";
import { buildCodingAgentSystemPrompt } from "./coding-agent-prompt";
import {
  defaultCodingAgentMode,
  getCodingAgentModeDefinition,
  type CodingAgentMode,
} from "./coding-agent-modes";

export function createCodingAgentTools() {
  return {
    list_files: tool({
      description: codingToolDescriptions.list_files,
      inputSchema: codingToolProviderInputSchemas.list_files,
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
    request_user_input: tool({
      description: codingToolDescriptions.request_user_input,
      inputSchema: codingToolProviderInputSchemas.request_user_input,
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

  return new ToolLoopAgent<{ cwd: string; mode?: CodingAgentMode }, typeof tools>({
    model,
    tools,
    stopWhen: stepCountIs(maxSteps),
    maxOutputTokens,
    providerOptions,
    callOptionsSchema: codingAgentCallOptionsSchema,
    prepareCall: ({ options, prompt, messages, ...settings }) => {
      const mode = options.mode ?? defaultCodingAgentMode;
      const modeDefinition = getCodingAgentModeDefinition(mode);

      return {
        ...settings,
        prompt,
        messages,
        activeTools: [...modeDefinition.activeTools],
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
