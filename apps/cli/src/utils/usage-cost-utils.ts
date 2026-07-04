import {
  getMessageUsageMetadata,
  type LightcodeConfigStatus,
  type MessageUsageMetadata,
} from "@lightcode/ai";
import type { UIMessage } from "ai";

export type ModelPricingInfo = NonNullable<LightcodeConfigStatus["pricing"]>;

const TOKENS_PER_MTOK = 1_000_000;

/**
 * USD cost of one turn from its reported usage. Cached input tokens bill at
 * the cache-read rate when known; unknown cache pricing falls back to the
 * full input rate (a slight overestimate beats a fake discount).
 */
export function computeUsageCostUsd(
  usage: MessageUsageMetadata["usage"] | undefined,
  pricing: ModelPricingInfo | null,
): number | null {
  if (!usage || !pricing) {
    return null;
  }

  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) {
    return null;
  }

  const cachedTokens = Math.min(usage.cachedInputTokens ?? 0, inputTokens);
  const freshInputTokens = inputTokens - cachedTokens;
  const cachedRate = pricing.cachedInputPerMTok ?? pricing.inputPerMTok;

  return (
    (freshInputTokens * pricing.inputPerMTok +
      cachedTokens * cachedRate +
      outputTokens * pricing.outputPerMTok) /
    TOKENS_PER_MTOK
  );
}

/**
 * Cumulative USD cost of the session: the sum of every assistant turn's
 * reported usage. Each turn bills its full request input, so summing turns
 * mirrors what the provider actually charges.
 */
export function computeSessionCostUsd(
  messages: readonly UIMessage[],
  pricing: ModelPricingInfo | null,
): number | null {
  if (!pricing) {
    return null;
  }

  let total = 0;
  let sawUsage = false;
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }

    const cost = computeUsageCostUsd(
      getMessageUsageMetadata(message)?.usage,
      pricing,
    );
    if (cost !== null) {
      total += cost;
      sawUsage = true;
    }
  }

  return sawUsage ? total : null;
}

export function formatUsd(value: number): string {
  if (value > 0 && value < 0.005) {
    return "<$0.01";
  }

  return `$${value.toFixed(2)}`;
}
