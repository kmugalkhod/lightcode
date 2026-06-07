import { cliTheme } from "../../ui/cli-theme";

interface LoadingTimerProps {
  /**
   * Elapsed time in seconds
   */
  elapsedSeconds: number;
}

/**
 * Displays a loading timer showing elapsed time while the assistant is thinking.
 * Formats the time as "Thinking 0:05", "Thinking 1:23", or "Thinking 1:05:32" for long durations.
 */
export function LoadingTimer({ elapsedSeconds }: LoadingTimerProps) {
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = Math.floor(elapsedSeconds % 60);

  const formattedTime = hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes}:${seconds.toString().padStart(2, "0")}`;

  return (
    <box paddingX={1}>
      <text fg={cliTheme.semantic.info}>Thinking {formattedTime}</text>
    </box>
  );
}