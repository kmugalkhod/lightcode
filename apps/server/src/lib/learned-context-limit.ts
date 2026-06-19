/**
 * Per-model record of the hard context limit a provider actually enforced.
 *
 * Catalog windows (e.g. OpenRouter's `context_length`) are optimistic: the
 * serving provider behind a model can cap lower, rejecting requests the catalog
 * said would fit. When an overflow error reports the real ceiling ("maximum
 * context length is N tokens"), we remember the smallest such value per model
 * so subsequent turns size their budget against the true limit and fit on the
 * first attempt — instead of burning the progressive overflow-recovery rounds.
 *
 * In-memory and process-local by design, mirroring overflow-recovery.ts. The
 * full session history on disk is untouched; this only informs the provider
 * view's budget.
 */
const learnedLimits = new Map<string, number>();

export function noteLearnedContextLimit(
  modelId: string,
  limitTokens: number | undefined | null,
): void {
  if (
    !modelId ||
    typeof limitTokens !== "number" ||
    !Number.isFinite(limitTokens) ||
    limitTokens <= 0
  ) {
    return;
  }

  const existing = learnedLimits.get(modelId);
  // Keep the tightest observed ceiling — a provider may report different limits
  // across routes; the smallest is the safe budget.
  if (existing === undefined || limitTokens < existing) {
    learnedLimits.set(modelId, Math.floor(limitTokens));
  }
}

export function getLearnedContextLimit(modelId: string): number | null {
  return learnedLimits.get(modelId) ?? null;
}

/** Test/runtime helper to reset the learned limit for a model. */
export function clearLearnedContextLimit(modelId?: string): void {
  if (modelId === undefined) {
    learnedLimits.clear();
    return;
  }
  learnedLimits.delete(modelId);
}
