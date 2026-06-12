import {
  assertProviderToolSchemaBudget,
  createCodingAgent,
  loadLightcodeConfig,
  updateUserSettings,
  type LightcodeConfigStatus,
  type LightcodeProvider,
  type LightcodeResolvedConfig,
} from "@lightcode/ai";
import { createLogger } from "@lightcode/shared";
import { getOpenRouterModelCapabilities } from "./openrouter-models";
import {
  createConfigStatus,
  resolveConfiguredProviderModel,
  type ProviderModelCapabilities,
  type ResolvedProviderModel,
} from "./provider-registry";

const logger = createLogger("runtime-config");

assertProviderToolSchemaBudget();

const codingAgentPromptOverride = Bun.env.LIGHTCODE_CODING_AGENT_SYSTEM_PROMPT;

function buildCodingAgent(
  config: LightcodeResolvedConfig,
  model: ResolvedProviderModel,
) {
  return createCodingAgent({
    model: model.model,
    promptOverride: codingAgentPromptOverride,
    providerOptions: model.providerOptions,
    maxSteps: config.maxSteps,
    maxRetries: config.maxRetries,
    maxOutputTokens: config.maxOutputTokens,
    includeToolDiscipline: model.needsToolCallDiscipline ?? false,
  });
}

// These are `let` + live ESM bindings on purpose: applyModelSelection swaps
// them atomically and every importer reads the new values on its next access.
// In-flight streams keep references to the old agent/model, which is safe.
export let lightcodeConfigResult = loadLightcodeConfig({
  cwd: process.cwd(),
  env: Bun.env,
});

export let resolvedProviderModel = resolveConfiguredProviderModel({
  config: lightcodeConfigResult.config,
  env: Bun.env,
});

export let configStatus = createConfigStatus({
  config: lightcodeConfigResult.config,
  loadedFiles: lightcodeConfigResult.loadedFiles,
  resolvedProviderModel,
});

export let chatModelId = resolvedProviderModel.resolvedModelId;

export let codingAgent = buildCodingAgent(
  lightcodeConfigResult.config,
  resolvedProviderModel,
);

export interface ApplyModelSelectionOptions {
  provider: LightcodeProvider;
  model: string;
  capabilities?: ProviderModelCapabilities;
  /** Persist the selection to the user settings file (default true). */
  persist?: boolean;
}

/**
 * Hot-swaps the active provider/model without a server restart. The new
 * model is resolved and validated first; only then is the runtime swapped,
 * so a bad selection never leaves the server without a working model.
 */
export function applyModelSelection({
  provider,
  model,
  capabilities,
  persist = true,
}: ApplyModelSelectionOptions): LightcodeConfigStatus {
  const nextConfig = {
    ...lightcodeConfigResult.config,
    provider,
    model,
  };

  const nextResolved = resolveConfiguredProviderModel({
    config: nextConfig,
    env: Bun.env,
    capabilities,
  });
  const nextAgent = buildCodingAgent(nextConfig, nextResolved);

  if (persist) {
    const { path } = updateUserSettings({ provider, model }, Bun.env);
    logger.info("model_selection_persisted", { path, provider, model });
  }

  lightcodeConfigResult = {
    ...lightcodeConfigResult,
    config: nextConfig,
  };
  resolvedProviderModel = nextResolved;
  chatModelId = nextResolved.resolvedModelId;
  codingAgent = nextAgent;
  configStatus = createConfigStatus({
    config: nextConfig,
    loadedFiles: lightcodeConfigResult.loadedFiles,
    resolvedProviderModel: nextResolved,
  });

  logger.info("model_selection_applied", {
    provider,
    model,
    contextWindow: nextResolved.contextWindow,
    supportsNativeTools: capabilities?.supportsNativeTools ?? null,
  });

  return configStatus;
}

/**
 * Best-effort startup enrichment: when the configured provider is OpenRouter,
 * pull the model's real context window from the (cached) models catalog and
 * re-apply the selection with it. Fire-and-forget — failures keep the static
 * metadata defaults.
 */
export async function initializeModelCapabilities(): Promise<void> {
  if (lightcodeConfigResult.config.provider !== "openrouter") {
    return;
  }

  const modelId = lightcodeConfigResult.config.model;
  if (!modelId) {
    return;
  }

  const capabilities = await getOpenRouterModelCapabilities(modelId);
  if (!capabilities || chatModelId !== modelId) {
    return;
  }

  applyModelSelection({
    provider: "openrouter",
    model: modelId,
    capabilities,
    persist: false,
  });
}
