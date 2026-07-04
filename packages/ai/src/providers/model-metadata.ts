import type { LightcodeProvider } from "../config/lightcode-config";
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from "../context/config";

const CLAUDE_4_CONTEXT_WINDOW_TOKENS = 200_000;

const anthropicContextWindows: Record<string, number> = {
  "claude-haiku-4-5": CLAUDE_4_CONTEXT_WINDOW_TOKENS,
  "claude-sonnet-4-6": CLAUDE_4_CONTEXT_WINDOW_TOKENS,
  "claude-opus-4-7": CLAUDE_4_CONTEXT_WINDOW_TOKENS,
};

/** Per-model token pricing in USD per million tokens. */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Price for cache-read input tokens; null when the model has no cache. */
  cachedInputPerMTok: number | null;
}

// Anthropic list prices (USD per MTok); cache reads bill at ~0.1x input.
const ANTHROPIC_CACHE_READ_FACTOR = 0.1;
const anthropicModelPricing: Record<string, Omit<ModelPricing, "cachedInputPerMTok">> = {
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-opus-4-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
};

/**
 * List pricing for a directly-served Anthropic model, or null for models not
 * in the table (custom endpoints, unknown ids). Prices are per million tokens.
 */
export function getAnthropicModelPricing(modelId: string): ModelPricing | null {
  const base = anthropicModelPricing[modelId];
  if (!base) {
    return null;
  }

  return {
    ...base,
    cachedInputPerMTok: base.inputPerMTok * ANTHROPIC_CACHE_READ_FACTOR,
  };
}

/**
 * Context window of a model in tokens. Falls back to a conservative default
 * for unknown models and arbitrary openai-compatible endpoints.
 */
export function getModelContextWindow(
  provider: LightcodeProvider,
  modelId: string,
): number {
  if (provider === "anthropic") {
    const known = anthropicContextWindows[modelId];
    if (known) {
      return known;
    }

    if (modelId.startsWith("claude-")) {
      return CLAUDE_4_CONTEXT_WINDOW_TOKENS;
    }
  }

  return DEFAULT_CONTEXT_WINDOW_TOKENS;
}
