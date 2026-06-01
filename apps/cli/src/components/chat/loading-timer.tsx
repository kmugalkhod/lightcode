import { cliTheme } from "../../ui/cli-theme";

interface LoadingTimerProps {
  /**
   * Elapsed time in seconds
   */
  elapsedSeconds: number;
}

/**
 * Displays a loading timer showing elapsed time while the assistant is thinking.
 * Formats the time as "0:05s" or "1:23s" format.
 */
export function LoadingTimer({ elapsedSeconds }: LoadingTimerProps) {
  // Format elapsed time as "M:SSs" or "0:SSs"
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = Math.floor(elapsedSeconds % 60);
  const formattedTime = `${minutes}:${seconds.toString().padStart(2, "0")}s`;

  return (
    <box paddingX={1}>
      <text fg={cliTheme.semantic.info}>⏱ {formattedTime}</text>
    </box>
  );
}
