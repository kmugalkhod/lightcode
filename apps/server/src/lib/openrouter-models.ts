import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createLogger, getErrorMessage, getLightcodeDataDir } from "@lightcode/shared";
import { z } from "zod";
import type { ProviderModelCapabilities } from "./provider-registry";

const logger = createLogger("openrouter-models");

const openRouterModelsUrl = "https://openrouter.ai/api/v1/models";
const cacheTtlMs = 24 * 60 * 60 * 1000;
const fetchTimeoutMs = 15_000;

export const openRouterModelSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  contextLength: z.number().int().positive().nullable(),
  // .default(null) keeps older on-disk caches (written before this field) valid.
  maxCompletionTokens: z.number().int().positive().nullable().default(null),
  supportsTools: z.boolean(),
  supportsReasoning: z.boolean(),
  pricing: z
    .object({
      prompt: z.string().nullable(),
      completion: z.string().nullable(),
    })
    .nullable(),
});
export type OpenRouterModelSummary = z.infer<typeof openRouterModelSummarySchema>;

const modelsCacheSchema = z.object({
  fetchedAt: z.number(),
  models: z.array(openRouterModelSummarySchema),
});
type ModelsCache = z.infer<typeof modelsCacheSchema>;

function getCacheFilePath() {
  return path.join(getLightcodeDataDir(), "cache", "openrouter-models.json");
}

function readCache(): ModelsCache | null {
  try {
    const cachePath = getCacheFilePath();
    if (!existsSync(cachePath)) {
      return null;
    }

    return modelsCacheSchema.parse(JSON.parse(readFileSync(cachePath, "utf8")));
  } catch {
    return null;
  }
}

function writeCache(cache: ModelsCache) {
  try {
    const cachePath = getCacheFilePath();
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache), "utf8");
  } catch (error) {
    logger.warn("openrouter_models_cache_write_failed", {
      error: getErrorMessage(error),
    });
  }
}

function summarizeRawModel(raw: unknown): OpenRouterModelSummary | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const id = Reflect.get(raw, "id");
  if (typeof id !== "string" || id.length === 0) {
    return null;
  }

  const name = Reflect.get(raw, "name");
  const contextLength = Reflect.get(raw, "context_length");
  // OpenRouter exposes the completion cap on top_provider (and sometimes at the
  // top level); prefer the provider-specific value.
  const topProvider = Reflect.get(raw, "top_provider");
  const topProviderMaxCompletion =
    typeof topProvider === "object" && topProvider !== null
      ? Reflect.get(topProvider, "max_completion_tokens")
      : undefined;
  const rawMaxCompletion =
    typeof topProviderMaxCompletion === "number"
      ? topProviderMaxCompletion
      : Reflect.get(raw, "max_completion_tokens");
  const supportedParameters = Reflect.get(raw, "supported_parameters");
  const parameterList = Array.isArray(supportedParameters)
    ? supportedParameters.filter((entry): entry is string => typeof entry === "string")
    : [];
  const pricingRaw = Reflect.get(raw, "pricing");
  const pricing =
    typeof pricingRaw === "object" && pricingRaw !== null
      ? {
          prompt:
            typeof Reflect.get(pricingRaw, "prompt") === "string"
              ? (Reflect.get(pricingRaw, "prompt") as string)
              : null,
          completion:
            typeof Reflect.get(pricingRaw, "completion") === "string"
              ? (Reflect.get(pricingRaw, "completion") as string)
              : null,
        }
      : null;

  return {
    id,
    name: typeof name === "string" && name.length > 0 ? name : id,
    contextLength:
      typeof contextLength === "number" && contextLength > 0
        ? Math.round(contextLength)
        : null,
    maxCompletionTokens:
      typeof rawMaxCompletion === "number" && rawMaxCompletion > 0
        ? Math.round(rawMaxCompletion)
        : null,
    supportsTools: parameterList.includes("tools"),
    supportsReasoning: parameterList.includes("reasoning"),
    pricing,
  };
}

async function fetchModelsFromApi(): Promise<OpenRouterModelSummary[]> {
  const response = await fetch(openRouterModelsUrl, {
    signal: AbortSignal.timeout(fetchTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter models API returned HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as { data?: unknown[] };
  const models = (payload.data ?? [])
    .map(summarizeRawModel)
    .filter((model): model is OpenRouterModelSummary => model !== null);

  if (models.length === 0) {
    throw new Error("OpenRouter models API returned no models.");
  }

  return models;
}

/**
 * Lists OpenRouter models with a 24h disk cache; a stale cache is served
 * when the live fetch fails so model switching keeps working offline.
 */
export async function listOpenRouterModels({
  forceRefresh = false,
}: { forceRefresh?: boolean } = {}): Promise<{
  models: OpenRouterModelSummary[];
  fromCache: boolean;
}> {
  const cache = readCache();
  if (!forceRefresh && cache && Date.now() - cache.fetchedAt < cacheTtlMs) {
    return { models: cache.models, fromCache: true };
  }

  try {
    const models = await fetchModelsFromApi();
    writeCache({ fetchedAt: Date.now(), models });
    return { models, fromCache: false };
  } catch (error) {
    logger.warn("openrouter_models_fetch_failed", {
      error: getErrorMessage(error),
    });

    if (cache) {
      return { models: cache.models, fromCache: true };
    }

    throw error;
  }
}

/**
 * Best-effort capability lookup for a single model. Returns undefined when
 * the catalog is unavailable or the model is unknown — callers then keep the
 * safe always-wrap default.
 */
export async function getOpenRouterModelCapabilities(
  modelId: string,
): Promise<ProviderModelCapabilities | undefined> {
  try {
    const { models } = await listOpenRouterModels();
    const model = models.find((entry) => entry.id === modelId);
    if (!model) {
      return undefined;
    }

    return {
      supportsNativeTools: model.supportsTools,
      contextLength: model.contextLength ?? undefined,
      maxCompletionTokens: model.maxCompletionTokens,
      pricing: toCapabilityPricing(model.pricing),
    };
  } catch {
    return undefined;
  }
}

/**
 * OpenRouter reports pricing as USD-per-token strings (e.g. "0.000003");
 * convert to USD per million tokens for display and cost math.
 */
function toCapabilityPricing(
  pricing: OpenRouterModelSummary["pricing"],
): ProviderModelCapabilities["pricing"] {
  if (!pricing?.prompt || !pricing.completion) {
    return null;
  }

  const promptPerToken = Number.parseFloat(pricing.prompt);
  const completionPerToken = Number.parseFloat(pricing.completion);
  if (!Number.isFinite(promptPerToken) || !Number.isFinite(completionPerToken)) {
    return null;
  }

  return {
    inputPerMTok: promptPerToken * 1_000_000,
    outputPerMTok: completionPerToken * 1_000_000,
  };
}
