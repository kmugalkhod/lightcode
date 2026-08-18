import { z } from "zod";
import type { StoredCredentials } from "../config/credentials";

export const webSearchBackendSchema = z.enum([
  "auto",
  "provider",
  "brave",
  "tavily",
  "disabled",
]);
export type WebSearchBackend = z.infer<typeof webSearchBackendSchema>;

/**
 * One-turn decision collected before exposing a provider-executed search tool.
 * Provider tools can perform network/billing work inside the model request, so
 * their approval cannot use the normal post-tool-call SDK approval flow.
 */
export const providerWebSearchDecisionSchema = z.enum(["approved", "denied"]);
export type ProviderWebSearchDecision = z.infer<
  typeof providerWebSearchDecisionSchema
>;

export const webSearchConfigSchema = z
  .object({
    backend: webSearchBackendSchema.optional(),
    maxResults: z.number().int().min(1).max(25).optional(),
    maxUsesPerTurn: z.number().int().min(1).max(30).optional(),
    maxCharactersPerResult: z.number().int().min(1).max(100_000).optional(),
    timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  })
  .strict();
export type WebSearchConfig = z.infer<typeof webSearchConfigSchema>;

export const resolvedWebSearchConfigSchema = z.object({
  backend: webSearchBackendSchema,
  maxResults: z.number().int().min(1).max(25),
  maxUsesPerTurn: z.number().int().min(1).max(30),
  maxCharactersPerResult: z.number().int().min(1).max(100_000),
  timeoutMs: z.number().int().min(1_000).max(120_000),
});
export type ResolvedWebSearchConfig = z.infer<
  typeof resolvedWebSearchConfigSchema
>;

export const defaultWebSearchConfig: ResolvedWebSearchConfig = {
  backend: "auto",
  maxResults: 3,
  maxUsesPerTurn: 3,
  maxCharactersPerResult: 1_200,
  timeoutMs: 20_000,
};

export function normalizeWebSearchConfig(
  config?: WebSearchConfig,
): ResolvedWebSearchConfig {
  return resolvedWebSearchConfigSchema.parse({
    ...defaultWebSearchConfig,
    ...config,
  });
}

export const resolvedWebSearchBackendSchema = z.enum([
  "openrouter",
  "anthropic",
  "brave",
  "tavily",
  "disabled",
  "unavailable",
]);
export type ResolvedWebSearchBackend = z.infer<
  typeof resolvedWebSearchBackendSchema
>;

export const webSearchExecutionSchema = z.enum(["provider", "local", "none"]);
export type WebSearchExecution = z.infer<typeof webSearchExecutionSchema>;

export const webSearchLimitsSchema = z.object({
  maxResults: z.number().int().positive(),
  maxTotalResults: z.number().int().positive(),
  maxUsesPerTurn: z.number().int().positive(),
  maxCharactersPerResult: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
});
export type WebSearchLimits = z.infer<typeof webSearchLimitsSchema>;

export const resolvedWebSearchCapabilitySchema = z.object({
  available: z.boolean(),
  backend: resolvedWebSearchBackendSchema,
  execution: webSearchExecutionSchema,
  limits: webSearchLimitsSchema,
  reason: z.string().nullable(),
});
export type ResolvedWebSearchCapability = z.infer<
  typeof resolvedWebSearchCapabilitySchema
>;

export interface ResolveWebSearchCapabilityOptions {
  config?: WebSearchConfig | ResolvedWebSearchConfig;
  provider: string;
  env?: Record<string, string | undefined>;
  storedCredentials?: StoredCredentials;
}

function envValue(
  env: Record<string, string | undefined>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function resolveWebSearchApiKeys({
  env = process.env,
  storedCredentials = {},
}: {
  env?: Record<string, string | undefined>;
  storedCredentials?: StoredCredentials;
} = {}): { brave: string | undefined; tavily: string | undefined } {
  return {
    brave:
      envValue(env, "BRAVE_SEARCH_API_KEY") ??
      storedCredentials.braveSearchApiKey,
    tavily:
      envValue(env, "TAVILY_API_KEY") ??
      storedCredentials.tavilyApiKey,
  };
}

function hasProviderCredential(
  provider: string,
  env: Record<string, string | undefined>,
  storedCredentials: StoredCredentials,
): boolean {
  if (provider === "openrouter") {
    return Boolean(
      envValue(
        env,
        "OPENROUTER_API_KEY",
        "LIGHTCODE_OPENAI_COMPATIBLE_API_KEY",
        "OPENAI_API_KEY",
      ) ?? storedCredentials.openrouterApiKey,
    );
  }

  if (provider === "anthropic") {
    return Boolean(
      envValue(env, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN") ??
        storedCredentials.anthropicApiKey,
    );
  }

  return false;
}

function providerBackend(provider: string): "openrouter" | "anthropic" | null {
  if (provider === "openrouter" || provider === "anthropic") {
    return provider;
  }

  return null;
}

function capability(
  config: ResolvedWebSearchConfig,
  fields: Omit<ResolvedWebSearchCapability, "limits">,
): ResolvedWebSearchCapability {
  return resolvedWebSearchCapabilitySchema.parse({
    ...fields,
    limits: {
      maxResults: config.maxResults,
      // Two result pages gives comparative queries room while bounding the
      // provider-side context independently of the number of search calls.
      maxTotalResults: config.maxResults * 2,
      maxUsesPerTurn: config.maxUsesPerTurn,
      maxCharactersPerResult: config.maxCharactersPerResult,
      timeoutMs: config.timeoutMs,
    },
  });
}

/**
 * Resolves search once, before a provider call. Explicit backends never fall
 * through; `auto` prefers a server-side tool and then configured local APIs.
 */
export function resolveWebSearchCapability({
  config: inputConfig,
  provider,
  env = process.env,
  storedCredentials = {},
}: ResolveWebSearchCapabilityOptions): ResolvedWebSearchCapability {
  const config = normalizeWebSearchConfig(inputConfig);
  const keys = resolveWebSearchApiKeys({ env, storedCredentials });
  const nativeBackend = providerBackend(provider);
  const nativeAvailable =
    nativeBackend !== null && hasProviderCredential(provider, env, storedCredentials);

  if (config.backend === "disabled") {
    return capability(config, {
      available: false,
      backend: "disabled",
      execution: "none",
      reason: "Web search is disabled in Lightcode settings.",
    });
  }

  if (config.backend === "provider") {
    if (!nativeBackend) {
      return capability(config, {
        available: false,
        backend: "unavailable",
        execution: "none",
        reason: `${provider} does not expose a supported provider-native web search tool.`,
      });
    }

    return capability(config, {
      available: nativeAvailable,
      backend: nativeBackend,
      execution: nativeAvailable ? "provider" : "none",
      reason: nativeAvailable
        ? null
        : `Configure ${nativeBackend === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY"} to use provider-native web search.`,
    });
  }

  if (config.backend === "brave" || config.backend === "tavily") {
    const available = Boolean(keys[config.backend]);
    return capability(config, {
      available,
      backend: config.backend,
      execution: available ? "local" : "none",
      reason: available
        ? null
        : `Configure ${config.backend === "brave" ? "BRAVE_SEARCH_API_KEY" : "TAVILY_API_KEY"} or save the corresponding search credential.`,
    });
  }

  if (nativeBackend && nativeAvailable) {
    return capability(config, {
      available: true,
      backend: nativeBackend,
      execution: "provider",
      reason: null,
    });
  }

  if (keys.brave) {
    return capability(config, {
      available: true,
      backend: "brave",
      execution: "local",
      reason: null,
    });
  }

  if (keys.tavily) {
    return capability(config, {
      available: true,
      backend: "tavily",
      execution: "local",
      reason: null,
    });
  }

  return capability(config, {
    available: false,
    backend: nativeBackend ?? "unavailable",
    execution: "none",
    reason: nativeBackend
      ? `Configure ${nativeBackend === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY"}, BRAVE_SEARCH_API_KEY, or TAVILY_API_KEY to enable web search.`
      : "Configure BRAVE_SEARCH_API_KEY or TAVILY_API_KEY to enable web search for this provider.",
  });
}
