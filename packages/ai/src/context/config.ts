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
    /** Hard override of the model context window, in tokens. */
    contextWindowOverride: z.number().int().min(8_000).max(10_000_000).optional(),
    summaryMaxChars: z.number().int().min(200).max(50_000).optional(),
    /** @deprecated Use contextWindowOverride. Kept so older configs still parse. */
    maxInputTokens: z.number().int().min(1).max(10_000_000).optional(),
  })
  .strict();

export const resolvedContextOptimizerConfigSchema = z.object({
  autoCompact: z.boolean(),
  compactAtFraction: z.number().min(0.3).max(0.95),
  pruneAtFraction: z.number().min(0.2).max(0.9),
  preserveRecentMessages: z.number().int().min(2).max(100),
  contextWindowOverride: z
    .number()
    .int()
    .min(8_000)
    .max(10_000_000)
    .nullable(),
  summaryMaxChars: z.number().int().min(200).max(50_000),
});

export type ContextOptimizerConfig = z.infer<typeof contextOptimizerConfigSchema>;
export type ResolvedContextOptimizerConfig = z.infer<
  typeof resolvedContextOptimizerConfigSchema
>;

export const defaultContextOptimizerConfig = {
  autoCompact: true,
  compactAtFraction: 0.8,
  pruneAtFraction: 0.6,
  preserveRecentMessages: 6,
  contextWindowOverride: null,
  summaryMaxChars: 4_000,
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

export function resolveContextWindowTokens({
  config,
  modelContextWindow,
}: {
  config: ResolvedContextOptimizerConfig;
  modelContextWindow?: number | null;
}): number {
  return (
    config.contextWindowOverride ??
    modelContextWindow ??
    DEFAULT_CONTEXT_WINDOW_TOKENS
  );
}
