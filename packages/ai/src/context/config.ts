import { z } from "zod";

/**
 * Default context window used when the active model's window is unknown
 * (e.g. arbitrary openai-compatible endpoints).
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

export const contextOptimizerConfigSchema = z
  .object({
    autoCompact: z.boolean().optional(),
    /** Fraction of the context window at which Tier-2 compaction triggers. */
    compactAtFraction: z.number().min(0.3).max(0.95).optional(),
    /** Fraction of the context window at which Tier-1 pruning starts. */
    pruneAtFraction: z.number().min(0.2).max(0.9).optional(),
    preserveRecentMessages: z.number().int().min(2).max(100).optional(),
    /**
     * Max estimated tokens a single Tier-2 compaction round folds into the
     * summary. Bounds the summarizer's own input on very long sessions; the
     * remainder is compacted on subsequent rounds (see the iterative loop in
     * chat-stream).
     */
    maxCoverageTokensPerCompaction: z
      .number()
      .int()
      .min(2_000)
      .max(200_000)
      .optional(),
    /** Hard override of the model context window, in tokens. */
    contextWindowOverride: z.number().int().min(8_000).max(10_000_000).optional(),
    summaryMaxChars: z.number().int().min(200).max(50_000).optional(),
    /**
     * When the active provider has no prompt cache to protect (e.g. OpenRouter),
     * prune more aggressively — the cache-warming conservatism below is pure
     * waste there. These knobs only take effect when caching is inactive.
     */
    aggressivePruneWhenUncached: z.boolean().optional(),
    uncachedPruneAtFraction: z.number().min(0.2).max(0.9).optional(),
    uncachedPruneMinOutputChars: z.number().int().min(200).max(12_000).optional(),
    uncachedQuantizeUserTurns: z.number().int().min(1).max(20).optional(),
    /** @deprecated Use contextWindowOverride. Kept so older configs still parse. */
    maxInputTokens: z.number().int().min(1).max(10_000_000).optional(),
  })
  .strict();

export const resolvedContextOptimizerConfigSchema = z.object({
  autoCompact: z.boolean(),
  compactAtFraction: z.number().min(0.3).max(0.95),
  pruneAtFraction: z.number().min(0.2).max(0.9),
  preserveRecentMessages: z.number().int().min(2).max(100),
  maxCoverageTokensPerCompaction: z.number().int().min(2_000).max(200_000),
  contextWindowOverride: z
    .number()
    .int()
    .min(8_000)
    .max(10_000_000)
    .nullable(),
  summaryMaxChars: z.number().int().min(200).max(50_000),
  aggressivePruneWhenUncached: z.boolean(),
  uncachedPruneAtFraction: z.number().min(0.2).max(0.9),
  uncachedPruneMinOutputChars: z.number().int().min(200).max(12_000),
  uncachedQuantizeUserTurns: z.number().int().min(1).max(20),
});

export type ContextOptimizerConfig = z.infer<typeof contextOptimizerConfigSchema>;
export type ResolvedContextOptimizerConfig = z.infer<
  typeof resolvedContextOptimizerConfigSchema
>;

export const defaultContextOptimizerConfig = {
  autoCompact: true,
  compactAtFraction: 0.7,
  pruneAtFraction: 0.6,
  preserveRecentMessages: 6,
  maxCoverageTokensPerCompaction: 12_000,
  contextWindowOverride: null,
  summaryMaxChars: 4_000,
  aggressivePruneWhenUncached: true,
  uncachedPruneAtFraction: 0.45,
  uncachedPruneMinOutputChars: 600,
  uncachedQuantizeUserTurns: 1,
} satisfies ResolvedContextOptimizerConfig;

export function normalizeContextOptimizerConfig(
  config: ContextOptimizerConfig | ResolvedContextOptimizerConfig | undefined,
): ResolvedContextOptimizerConfig {
  const candidate: Record<string, unknown> = {
    ...defaultContextOptimizerConfig,
    ...(config ?? {}),
  };

  // Back-compat: maxInputTokens used to be the absolute compaction threshold.
  // Treat it as a context-window override when no explicit override is set.
  const legacyMaxInputTokens = candidate.maxInputTokens;
  delete candidate.maxInputTokens;
  if (
    typeof legacyMaxInputTokens === "number" &&
    (candidate.contextWindowOverride === null ||
      candidate.contextWindowOverride === undefined)
  ) {
    candidate.contextWindowOverride = Math.max(8_000, legacyMaxInputTokens);
  }

  return resolvedContextOptimizerConfigSchema.parse(candidate);
}

/**
 * Fraction of the (output-adjusted) window left for input after a safety
 * margin. Token estimation is heuristic (chars/4) and the provider's tokenizer
 * is stricter on dense content, so the input budget is held below the real
 * ceiling to absorb that drift.
 */
export const DEFAULT_INPUT_BUDGET_SAFETY_FRACTION = 0.92;

export function resolveContextWindowTokens({
  config,
  modelContextWindow,
  endpointLimitTokens,
}: {
  config: ResolvedContextOptimizerConfig;
  modelContextWindow?: number | null;
  /**
   * A hard cap learned from a provider overflow error ("maximum context length
   * is N tokens"). Catalog windows (e.g. OpenRouter's) are optimistic and can
   * exceed the actual serving provider's limit, so the effective window is
   * clamped to this when known.
   */
  endpointLimitTokens?: number | null;
}): number {
  const resolved =
    config.contextWindowOverride ??
    modelContextWindow ??
    DEFAULT_CONTEXT_WINDOW_TOKENS;

  if (
    typeof endpointLimitTokens === "number" &&
    Number.isFinite(endpointLimitTokens) &&
    endpointLimitTokens > 0
  ) {
    return Math.min(resolved, endpointLimitTokens);
  }

  return resolved;
}

/**
 * The hard input-token budget for an assembled request: the context window
 * minus the tokens reserved for the model's output (the provider counts input +
 * output against the same ceiling) minus a safety margin. Used both to size the
 * compaction thresholds and as the ceiling for {@link fitMessagesToBudget}.
 */
export function resolveInputBudgetTokens({
  contextWindow,
  reservedOutputTokens,
  safetyFraction = DEFAULT_INPUT_BUDGET_SAFETY_FRACTION,
}: {
  contextWindow: number;
  reservedOutputTokens?: number | null;
  safetyFraction?: number;
}): number {
  const reserved =
    typeof reservedOutputTokens === "number" &&
    Number.isFinite(reservedOutputTokens) &&
    reservedOutputTokens > 0
      ? reservedOutputTokens
      : 0;
  const clampedFraction = Math.min(1, Math.max(0.1, safetyFraction));
  const usable = Math.max(0, contextWindow - reserved);
  return Math.max(0, Math.floor(usable * clampedFraction));
}
