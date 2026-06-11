import { estimateContextTokens } from "@lightcode/ai";
import type { UIMessage } from "ai";

export type ContextMeterLevel = "normal" | "warning" | "critical";

const WARNING_PERCENTAGE = 60;
const CRITICAL_PERCENTAGE = 85;

export interface ContextEstimate {
  /** Estimated provider-facing tokens for the current conversation. */
  tokens: number;
  /** "usage_calibrated" once real provider usage metadata is available. */
  basis: "usage_calibrated" | "heuristic";
  /** Usage percentage of the context window (0-100). */
  percentage: number;
  level: ContextMeterLevel;
  /** Formatted display string like "61k/200k 31%". */
  displayText: string;
}

function formatTokenCount(tokens: number): string {
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : `${tokens}`;
}

/**
 * Estimates context usage against the active model's context window using
 * the same estimator as the server (calibrated by real provider usage
 * metadata once the first assistant response arrives).
 */
export function estimateContextUsage(
  messages: UIMessage[],
  contextWindow: number,
): ContextEstimate {
  const estimate = estimateContextTokens(messages);
  const percentage = Math.min(
    100,
    Math.round((estimate.tokens / Math.max(1, contextWindow)) * 100),
  );
  const level: ContextMeterLevel =
    percentage >= CRITICAL_PERCENTAGE
      ? "critical"
      : percentage >= WARNING_PERCENTAGE
        ? "warning"
        : "normal";

  return {
    tokens: estimate.tokens,
    basis: estimate.basis,
    percentage,
    level,
    displayText: `${formatTokenCount(estimate.tokens)}/${formatTokenCount(contextWindow)} ${percentage}%`,
  };
}
