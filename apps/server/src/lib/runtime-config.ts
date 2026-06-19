import {
  assertProviderToolSchemaBudget,
  createCodingAgent,
  lightcodeConfigDefaults,
  loadLightcodeConfig,
  resolveMaxOutputTokens,
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
    // Per-model output budget: when left at the default, use the model's full
    // advertised max_completion_tokens (e.g. 512K for minimax-m3) so the model
    // finishes in one turn instead of truncating at a small fixed cap and
    // forcing the fragile auto-continue path. An explicit user value is honored
    // and clamped down to the model's real cap.
    maxOutputTokens: resolveMaxOutputTokens(
      config.maxOutputTokens,
      lightcodeConfigDefaults.maxOutputTokens,
      model.maxCompletionTokens,
    ),
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
 * Reloads config and credentials from disk and hot-swaps the live runtime, no
 * server restart required. Used after onboarding writes settings.json /
 * credentials.json so the change applies even when this server process was not
 * spawned by the current CLI (e.g. an orphaned server still holding the port).
 * Mirrors applyModelSelection's atomic swap of the live ESM bindings.
 */
export function reloadRuntimeConfig(): LightcodeConfigStatus {
  const nextConfigResult = loadLightcodeConfig({
    cwd: process.cwd(),
    env: Bun.env,
  });
  const nextResolved = resolveConfiguredProviderModel({
    config: nextConfigResult.config,
    env: Bun.env,
  });
  const nextAgent = buildCodingAgent(nextConfigResult.config, nextResolved);

  lightcodeConfigResult = nextConfigResult;
  resolvedProviderModel = nextResolved;
  chatModelId = nextResolved.resolvedModelId;
  codingAgent = nextAgent;
  configStatus = createConfigStatus({
    config: nextConfigResult.config,
    loadedFiles: nextConfigResult.loadedFiles,
    resolvedProviderModel: nextResolved,
  });

  logger.info("runtime_config_reloaded", {
    provider: nextConfigResult.config.provider,
    model: nextConfigResult.config.model,
  });

  return configStatus;
}

/**
 * Fail-open switch for the headroom proxy facility: re-resolves the live model
 * with headroom routing forced off and swaps it in atomically, so traffic goes
 * straight to the real provider. Called by the startup health gate when the
 * proxy is unreachable. No-op (and no persistence) when routing is already off.
 */
export function disableHeadroomRouting(): void {
  if (!lightcodeConfigResult.config.headroom?.enabled) {
    return;
  }

  const nextConfig: LightcodeResolvedConfig = {
    ...lightcodeConfigResult.config,
    headroom: {
      ...(lightcodeConfigResult.config.headroom ?? lightcodeConfigDefaults.headroom),
      enabled: false,
    },
  };

  const nextResolved = resolveConfiguredProviderModel({
    config: nextConfig,
    env: Bun.env,
  });
  const nextAgent = buildCodingAgent(nextConfig, nextResolved);

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

  logger.info("headroom_routing_disabled", {
    provider: nextResolved.provider,
    model: nextResolved.resolvedModelId,
  });
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
