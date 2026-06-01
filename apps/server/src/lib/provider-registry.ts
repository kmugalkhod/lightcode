import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import {
  lightcodeConfigStatusSchema,
  type LightcodeConfigStatus,
  type LightcodeResolvedConfig,
  type LoadedConfigFile,
} from "@lightcode/ai";

export interface ResolvedProviderModel {
  provider: LightcodeResolvedConfig["provider"];
  configuredModel: string | null;
  resolvedModelId: string;
  baseUrl: string | null;
  model: LanguageModel;
  providerOptions?: SharedV3ProviderOptions;
  missingCredentialHints: string[];
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

function resolveAnthropicModel({
  config,
  env,
}: {
  config: LightcodeResolvedConfig;
  env: Record<string, string | undefined>;
}): ResolvedProviderModel {
  const configuredModel = config.model ?? null;
  const modelId = resolveModelAlias(
    "anthropic",
    configuredModel ?? "haiku",
  );
  const apiKey = getEnvValue(env, "ANTHROPIC_API_KEY");
  const authToken = getEnvValue(env, "ANTHROPIC_AUTH_TOKEN");
  const baseUrl = config.baseUrl ?? getEnvValue(env, "ANTHROPIC_BASE_URL") ?? null;
  const missingCredentialHints =
    apiKey || authToken
      ? []
      : [
          "Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN to call Anthropic models.",
        ];
  const provider = createAnthropic({
    apiKey,
    authToken,
    baseURL: baseUrl ?? undefined,
  });

  return {
    provider: "anthropic",
    configuredModel,
    resolvedModelId: modelId,
    baseUrl,
    model: provider(modelId),
    providerOptions: getAnthropicProviderOptions(modelId),
    missingCredentialHints,
  };
}

function resolveOpenAITransportModel({
  config,
  env,
}: {
  config: LightcodeResolvedConfig;
  env: Record<string, string | undefined>;
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

  const apiKey = isOpenCodeZen
    ? getEnvValue(
        env,
        "OPENCODE_API_KEY",
        "LIGHTCODE_OPENAI_COMPATIBLE_API_KEY",
        "OPENAI_API_KEY",
      )
    : isOpenRouter
      ? getEnvValue(
          env,
          "OPENROUTER_API_KEY",
          "LIGHTCODE_OPENAI_COMPATIBLE_API_KEY",
          "OPENAI_API_KEY",
        )
    : getEnvValue(
        env,
        "LIGHTCODE_OPENAI_COMPATIBLE_API_KEY",
        "OPENAI_API_KEY",
      );
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
    baseURL: baseUrl,
    apiKey,
    headers,
  });

  return {
    provider: config.provider,
    configuredModel,
    resolvedModelId: configuredModel,
    baseUrl,
    model: provider(configuredModel),
    missingCredentialHints: apiKey
      ? []
      : isOpenCodeZen
        ? ["Set OPENCODE_API_KEY to call OpenCode Zen models."]
        : isOpenRouter
          ? ["Set OPENROUTER_API_KEY to call OpenRouter models."]
        : [
            "Set LIGHTCODE_OPENAI_COMPATIBLE_API_KEY or OPENAI_API_KEY if your OpenAI-compatible endpoint requires authentication.",
          ],
  };
}

export function resolveConfiguredProviderModel({
  config,
  env = Bun.env,
}: {
  config: LightcodeResolvedConfig;
  env?: Record<string, string | undefined>;
}): ResolvedProviderModel {
  if (
    config.provider === "openai-compatible" ||
    config.provider === "opencode-zen" ||
    config.provider === "openrouter"
  ) {
    return resolveOpenAITransportModel({ config, env });
  }

  return resolveAnthropicModel({ config, env });
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
    maxOutputTokens: config.maxOutputTokens,
    maxSteps: config.maxSteps,
    missingCredentialHints: resolvedProviderModel.missingCredentialHints,
  });
}
