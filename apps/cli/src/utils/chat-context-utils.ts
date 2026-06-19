import { estimateContextTokens, getMessageUsageMetadata } from "@lightcode/ai";
import type { UIMessage } from "ai";

export type ContextMeterLevel = "normal" | "warning" | "critical";

const WARNING_PERCENTAGE = 60;
const CRITICAL_PERCENTAGE = 85;

/**
 * Server-measured context state from the most recent assistant message, when
 * present. This is authoritative: the local heuristic under-reports once the
 * summary anchor is lost, so prefer the server's number whenever we have it.
 */
function latestServerContext(
  messages: UIMessage[],
): { inputTokens: number; contextWindow: number } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const context = getMessageUsageMetadata(messages[index])?.context;
    if (context) {
      return {
        inputTokens: context.inputTokens,
        contextWindow: context.contextWindow,
      };
    }
  }
  return null;
}

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
  // Prefer the server's measured context (authoritative) over the local
  // calibration-blind heuristic; fall back to the heuristic before the first
  // assistant response arrives.
  const serverContext = latestServerContext(messages);
  const estimate = serverContext
    ? ({ tokens: serverContext.inputTokens, basis: "usage_calibrated" } as const)
    : estimateContextTokens(messages);
  const effectiveWindow = serverContext?.contextWindow ?? contextWindow;
  const percentage = Math.min(
    100,
    Math.round((estimate.tokens / Math.max(1, effectiveWindow)) * 100),
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
    displayText: `${formatTokenCount(estimate.tokens)}/${formatTokenCount(effectiveWindow)} ${percentage}%`,
  };
}
