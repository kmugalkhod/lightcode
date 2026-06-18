/**
 * Clamps the configured max output tokens to the model's real completion cap.
 *
 * Some OpenRouter models advertise a `max_completion_tokens` well below common
 * defaults (lightcode defaults to 32768) and hard-reject — HTTP 400 — any
 * request that asks for more, which surfaces to the user as an "output limit"
 * failure before a single token streams. This never raises the configured
 * value; it only lowers it to a known cap, and falls back to the configured
 * value when the cap is unknown.
 */
export function clampMaxOutputTokens(
  configured: number,
  modelMaxCompletionTokens?: number | null,
): number {
  if (
    typeof modelMaxCompletionTokens === "number" &&
    Number.isFinite(modelMaxCompletionTokens) &&
    modelMaxCompletionTokens > 0
  ) {
    return Math.min(configured, modelMaxCompletionTokens);
  }

  return configured;
}

/**
 * Resolves the effective max output tokens to send for a model.
 *
 * The fix for "I truncate every time but pi (same model) never does": a fixed
 * default (e.g. 32768) caps high-capacity models far below their real ceiling
 * — minimax-m3 advertises 512K output, so a 32K cap forces constant truncation
 * and the fragile auto-continue path. When the user left `maxOutputTokens` at
 * the built-in default, give the model its full advertised output budget
 * (per-model, from the provider catalog). An explicit user value is always
 * honored — clamped down to the model's real cap so it can never 400.
 *
 * `maxOutputTokens` is a ceiling, not a target: the model stops at end-of-turn
 * and only generates what it needs, so a high per-model ceiling costs nothing
 * in normal use — it just removes premature truncation.
 */
export function resolveMaxOutputTokens(
  configured: number,
  defaultValue: number,
  modelMaxCompletionTokens?: number | null,
): number {
  const hasModelCap =
    typeof modelMaxCompletionTokens === "number" &&
    Number.isFinite(modelMaxCompletionTokens) &&
    modelMaxCompletionTokens > 0;

  if (configured === defaultValue) {
    return hasModelCap ? (modelMaxCompletionTokens as number) : configured;
  }

  return clampMaxOutputTokens(configured, modelMaxCompletionTokens);
}
