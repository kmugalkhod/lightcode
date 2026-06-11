import {
  assertProviderToolSchemaBudget,
  createCodingAgent,
  loadLightcodeConfig,
} from "@lightcode/ai";
import {
  createConfigStatus,
  resolveConfiguredProviderModel,
} from "./provider-registry";

assertProviderToolSchemaBudget();

export const lightcodeConfigResult = loadLightcodeConfig({
  cwd: process.cwd(),
  env: Bun.env,
});

export const resolvedProviderModel = resolveConfiguredProviderModel({
  config: lightcodeConfigResult.config,
  env: Bun.env,
});

export const configStatus = createConfigStatus({
  config: lightcodeConfigResult.config,
  loadedFiles: lightcodeConfigResult.loadedFiles,
  resolvedProviderModel,
});

export const chatModelId = resolvedProviderModel.resolvedModelId;
const codingAgentPromptOverride = Bun.env.LIGHTCODE_CODING_AGENT_SYSTEM_PROMPT;

export const codingAgent = createCodingAgent({
  model: resolvedProviderModel.model,
  promptOverride: codingAgentPromptOverride,
  providerOptions: resolvedProviderModel.providerOptions,
  maxSteps: lightcodeConfigResult.config.maxSteps,
  maxOutputTokens: lightcodeConfigResult.config.maxOutputTokens,
  includeToolDiscipline: resolvedProviderModel.needsToolCallDiscipline ?? false,
});
