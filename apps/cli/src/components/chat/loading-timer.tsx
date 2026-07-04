import { cliTheme } from "../../ui/cli-theme";
import { terminalCapabilities } from "../../ui/cli-theme-capabilities";
import { useSpinner } from "../../ui/hooks/use-spinner";
import { formatUsd } from "../../utils/usage-cost-utils";

interface LoadingTimerProps {
  /**
   * Elapsed time in seconds
   */
  elapsedSeconds: number;
  /**
   * Output tokens generated so far this turn, if known. Rendered as a compact
   * suffix (e.g. "· 1.2k tok") so the user sees the turn is making progress.
   */
  outputTokens?: number;
  /**
   * Cost of the current turn in USD, once its usage is reported. Hidden while
   * null/undefined (pricing unknown or turn still streaming).
   */
  costUsd?: number | null;
}

function formatTokens(tokens: number): string {
  return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}k` : `${tokens}`;
}

/**
 * Displays a loading timer showing elapsed time while the assistant is thinking.
 * Formats the time as "Thinking 0:05", "Thinking 1:23", or "Thinking 1:05:32" for long durations.
 */
export function LoadingTimer({ elapsedSeconds, outputTokens, costUsd }: LoadingTimerProps) {
  const spinner = useSpinner({
    active: true,
    reducedMotion: terminalCapabilities.reducedMotion,
    ascii: !terminalCapabilities.unicode,
  });
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = Math.floor(elapsedSeconds % 60);

  const formattedTime = hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes}:${seconds.toString().padStart(2, "0")}`;

  const tokenSuffix =
    typeof outputTokens === "number" && outputTokens > 0
      ? ` · ${formatTokens(outputTokens)} tok`
      : "";
  const costSuffix =
    typeof costUsd === "number" && costUsd > 0 ? ` · ${formatUsd(costUsd)}` : "";

  return (
    <box paddingX={1} flexDirection="row" gap={1}>
      <text fg={cliTheme.accent.primary}>{spinner}</text>
      <text fg={cliTheme.semantic.info}>Thinking {formattedTime}{tokenSuffix}{costSuffix}</text>
    </box>
  );
}