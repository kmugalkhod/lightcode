import type { ContextReport } from "../lib/api";

// Same thresholds as the terminal footer (apps/cli chat-context-utils).
const warningPercentage = 60;
const criticalPercentage = 85;

export type ContextLevel = "normal" | "warning" | "critical";

export function contextUsage(report: ContextReport): {
  percentage: number;
  level: ContextLevel;
} {
  const percentage = Math.min(
    100,
    Math.round((report.estimate.tokens / Math.max(1, report.contextWindow)) * 100),
  );
  const level =
    percentage >= criticalPercentage
      ? "critical"
      : percentage >= warningPercentage
        ? "warning"
        : "normal";
  return { percentage, level };
}

const formatTokens = (value: number) =>
  value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);

/** "ctx 42%" with tokens and compaction in the tooltip, like the TUI footer. */
export function ContextMeter({ report }: { report: ContextReport | null }) {
  if (!report) return null;
  const { percentage, level } = contextUsage(report);
  const compacted = report.breakdown.compactedTokens;
  const detail = [
    `${formatTokens(report.estimate.tokens)} of ${formatTokens(report.contextWindow)} tokens`,
    `${formatTokens(report.breakdown.remainingTokens)} left`,
    compacted > 0 ? `${formatTokens(compacted)} compacted` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className={`context-meter ${level}`} title={detail} aria-label={`Context ${percentage}% used. ${detail}`}>
      <span className="context-meter-bar" aria-hidden="true">
        <span style={{ width: `${percentage}%` }} />
      </span>
      ctx {percentage}%{compacted > 0 ? " · compacted" : ""}
    </span>
  );
}
