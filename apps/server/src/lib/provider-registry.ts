import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import {
  getModelContextWindow,
  lightcodeConfigDefaults,
  lightcodeConfigStatusSchema,
  readStoredCredentials,
  resolveContextWindowTokens,
  resolveMaxOutputTokens,
  withXmlToolCallSupport,
  type LightcodeConfigStatus,
  type LightcodeResolvedConfig,
  type LoadedConfigFile,
  type StoredCredentials,
} from "@lightcode/ai";

export interface ProviderModelCapabilities {
  /** True when the model handles native function/tool calls itself. */
  supportsNativeTools?: boolean;
  /** Context window in tokens from live provider metadata. */
  contextLength?: number;
  /** Max completion tokens the routed provider accepts, when advertised. */
  maxCompletionTokens?: number | null;
}

export interface ResolvedProviderModel {
  provider: LightcodeResolvedConfig["provider"];
  configuredModel: string | null;
  resolvedModelId: string;
  /** The REAL upstream provider URL (never the proxy) — used by diagnostics. */
  baseUrl: string | null;
  /** The base URL actually handed to the SDK (the proxy when headroom routes). */
  effectiveBaseUrl: string | null;
  /** True when traffic is routed through the headroom compressing proxy. */
  headroomRouted: boolean;
  model: LanguageModel;
  providerOptions?: SharedV3ProviderOptions;
  /** Context window of the resolved model in tokens (model metadata). */
  contextWindow: number;
  missingCredentialHints: string[];
  /**
   * True when the model goes through the XML tool-call middleware — the
   * system prompt should include tool-calling discipline for it.
   */
  needsToolCallDiscipline?: boolean;
  /** Max completion tokens the model accepts, for clamping maxOutputTokens. */
  maxCompletionTokens?: number | null;
}

const anthropicModelAliases = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
} as const;
const opencodeZenDefaultBaseUrl = "https://opencode.ai/zen/v1";
const openRouterDefaultBaseUrl = "https://openrouter.ai/api/v1";

function getEnvValue(
  env: Record<string, string | undefined>,
  ...keys: string[]
) {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function resolveModelAlias(
  provider: LightcodeResolvedConfig["provider"],
  model: string,
) {
  if (provider !== "anthropic") {
    return model;
  }

  return anthropicModelAliases[
    model as keyof typeof anthropicModelAliases
  ] ?? model;
}

function getAnthropicProviderOptions(
  modelId: string,
): SharedV3ProviderOptions | undefined {
  if (modelId !== "claude-opus-4-7") {
    return undefined;
  }

  return {
    anthropic: {
      thinking: {
        type: "adaptive",
        display: "summarized",
      },
      effort: "medium",
    },
  };
}

/**
 * Decides the base URL actually sent to the provider SDK. When the headroom
 * facility is enabled (and covers this provider), traffic is redirected to the
 * local compressing proxy — the same mechanism `headroom wrap claude` uses. The
 * real upstream URL is returned separately so diagnostics keep probing it.
 */
function resolveHeadroomRouting(
  config: LightcodeResolvedConfig,
  realBaseUrl: string | null,
): { effectiveBaseUrl: string | null; headroomRouted: boolean } {
  const headroom = config.headroom;
  if (!headroom?.enabled) {
    return { effectiveBaseUrl: realBaseUrl, headroomRouted: false };
  }

  // A null `providers` list means "route every provider"; a concrete list
  // scopes routing (e.g. only OpenRouter, where there is no prompt cache to
  // disturb) and leaves the others talking to the real upstream.
  if (headroom.providers && !headroom.providers.includes(config.provider)) {
    return { effectiveBaseUrl: realBaseUrl, headroomRouted: false };
  }

  return { effectiveBaseUrl: headroom.proxyUrl, headroomRouted: true };
}

function resolveAnthropicModel({
  config,
  env,
  storedCredentials,
}: {
  config: LightcodeResolvedConfig;
  env: Record<string, string | undefined>;
  storedCredentials: StoredCredentials;
}): ResolvedProviderModel {
  const configuredModel = config.model ?? null;
  const modelId = resolveModelAlias(
    "anthropic",
    configuredModel ?? "haiku",
  );
  const apiKey =
    getEnvValue(env, "ANTHROPIC_API_KEY") ?? storedCredentials.anthropicApiKey;
  const authToken = getEnvValue(env, "ANTHROPIC_AUTH_TOKEN");
  const baseUrl = config.baseUrl ?? getEnvValue(env, "ANTHROPIC_BASE_URL") ?? null;
  const { effectiveBaseUrl, headroomRouted } = resolveHeadroomRouting(
    config,
    baseUrl,
  );
  const missingCredentialHints =
    apiKey || authToken
      ? []
      : [
          "Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN to call Anthropic models.",
        ];
  const provider = createAnthropic({
    apiKey,
    authToken,
    baseURL: effectiveBaseUrl ?? undefined,
  });

  return {
    provider: "anthropic",
    configuredModel,
    resolvedModelId: modelId,
    baseUrl,
    effectiveBaseUrl,
    headroomRouted,
    model: provider(modelId),
    providerOptions: getAnthropicProviderOptions(modelId),
    contextWindow: getModelContextWindow("anthropic", modelId),
    missingCredentialHints,
  };
}

function resolveOpenAITransportModel({
  config,
  env,
  storedCredentials,
  capabilities,
}: {
  config: LightcodeResolvedConfig;
  env: Record<string, string | undefined>;
  storedCredentials: StoredCredentials;
  capabilities?: ProviderModelCapabilities;
}): ResolvedProviderModel {
  const isOpenCodeZen = config.provider === "opencode-zen";
  const isOpenRouter = config.provider === "openrouter";
  const configuredModel = config.model ?? null;
  if (!configuredModel) {
    throw new Error(
      `"${config.provider}" provider requires a configured "model" value.`,
    );
  }

  const baseUrl =
    config.baseUrl ??
    (isOpenCodeZen
      ? getEnvValue(env, "OPENCODE_ZEN_BASE_URL") ?? opencodeZenDefaultBaseUrl
      : isOpenRouter
        ? getEnvValue(env, "OPENROUTER_BASE_URL") ?? openRouterDefaultBaseUrl
        : getEnvValue(
          env,
          "LIGHTCODE_OPENAI_COMPATIBLE_BASE_URL",
          "OPENAI_BASE_URL",
        ));
  if (!baseUrl) {
    throw new Error(
      'OpenAI-compatible provider requires "baseUrl" in config or LIGHTCODE_OPENAI_COMPATIBLE_BASE_URL.',
    );
  }
  const { effectiveBaseUrl, headroomRouted } = resolveHeadroomRouting(
    config,
    baseUrl,
  );

  const apiKey = isOpenCodeZen
    ? getEnvValue(
        env,
        "OPENCODE_API_KEY",
        "LIGHTCODE_OPENAI_COMPATIBLE_API_KEY",
        "OPENAI_API_KEY",
      ) ?? storedCredentials.opencodeApiKey
    : isOpenRouter
      ? getEnvValue(
          env,
          "OPENROUTER_API_KEY",
          "LIGHTCODE_OPENAI_COMPATIBLE_API_KEY",
          "OPENAI_API_KEY",
        ) ?? storedCredentials.openrouterApiKey
    : getEnvValue(
        env,
        "LIGHTCODE_OPENAI_COMPATIBLE_API_KEY",
        "OPENAI_API_KEY",
      ) ?? storedCredentials.openaiCompatibleApiKey;
  const headers: Record<string, string> = {};
  if (isOpenRouter) {
    const referer = getEnvValue(env, "OPENROUTER_HTTP_REFERER");
    const title = getEnvValue(env, "OPENROUTER_APP_TITLE", "LIGHTCODE_APP_TITLE");
    if (referer) {
      headers["HTTP-Referer"] = referer;
    }
    if (title) {
      headers["X-OpenRouter-Title"] = title;
    }
  }
  const provider = createOpenAICompatible({
    name: config.provider,
    baseURL: effectiveBaseUrl ?? baseUrl,
    apiKey,
    headers,
  });

  // The XML middleware stays on for every OpenAI-compatible model: it passes
  // native function calls through untouched and only converts <tool_call>
  // XML found in text. Models like MiniMax advertise native tools via the
  // OpenRouter catalog yet still emit XML in practice, so capability data is
  // NOT a safe signal to unwrap — it only improves the context window.
  return {
    provider: config.provider,
    configuredModel,
    resolvedModelId: configuredModel,
    baseUrl,
    effectiveBaseUrl,
    headroomRouted,
    model: withXmlToolCallSupport(provider(configuredModel)),
    needsToolCallDiscipline: true,
    contextWindow:
      capabilities?.contextLength ??
      getModelContextWindow(config.provider, configuredModel),
    missingCredentialHints: apiKey
      ? []
      : isOpenCodeZen
        ? ["Set OPENCODE_API_KEY to call OpenCode Zen models."]
        : isOpenRouter
          ? ["Set OPENROUTER_API_KEY to call OpenRouter models."]
        : [
            "Set LIGHTCODE_OPENAI_COMPATIBLE_API_KEY or OPENAI_API_KEY if your OpenAI-compatible endpoint requires authentication.",
          ],
    maxCompletionTokens: capabilities?.maxCompletionTokens ?? null,
  };
}

export function resolveConfiguredProviderModel({
  config,
  env = Bun.env,
  capabilities,
}: {
  config: LightcodeResolvedConfig;
  env?: Record<string, string | undefined>;
  capabilities?: ProviderModelCapabilities;
}): ResolvedProviderModel {
  const storedCredentials = readStoredCredentials(env);

  if (
    config.provider === "openai-compatible" ||
    config.provider === "opencode-zen" ||
    config.provider === "openrouter"
  ) {
    return resolveOpenAITransportModel({
      config,
      env,
      storedCredentials,
      capabilities,
    });
  }

  return resolveAnthropicModel({ config, env, storedCredentials });
}

export function createConfigStatus({
  config,
  loadedFiles,
  resolvedProviderModel,
}: {
  config: LightcodeResolvedConfig;
  loadedFiles: LoadedConfigFile[];
  resolvedProviderModel: ResolvedProviderModel;
}): LightcodeConfigStatus {
  return lightcodeConfigStatusSchema.parse({
    loadedFiles,
    selectedProvider: resolvedProviderModel.provider,
    configuredModel: resolvedProviderModel.configuredModel,
    selectedModel: resolvedProviderModel.resolvedModelId,
    baseUrl: resolvedProviderModel.baseUrl,
    defaultMode: config.defaultMode,
    permissionMode: config.permissionMode ?? null,
    // Report the effective per-model ceiling actually sent to the provider, not
    // the raw config default — so /config shows e.g. 512000 for minimax-m3.
    maxOutputTokens: resolveMaxOutputTokens(
      config.maxOutputTokens,
      lightcodeConfigDefaults.maxOutputTokens,
      resolvedProviderModel.maxCompletionTokens,
    ),
    maxSteps: config.maxSteps,
    autoContinue: config.autoContinue,
    contextWindow: resolveContextWindowTokens({
      config: config.context,
      modelContextWindow: resolvedProviderModel.contextWindow,
    }),
    headroom: {
      enabled: config.headroom?.enabled ?? false,
      proxyUrl: config.headroom?.proxyUrl ?? null,
      // `routed` reflects the resolved model, so when the startup health gate
      // fails open it re-resolves with routing off and this drops to false.
      routed: resolvedProviderModel.headroomRouted,
    },
    missingCredentialHints: resolvedProviderModel.missingCredentialHints,
  });
}
