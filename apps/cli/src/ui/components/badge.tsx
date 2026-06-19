import { cliTheme } from "../cli-theme";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "error";

const toneColor: Record<BadgeTone, string> = {
  neutral: cliTheme.text.secondary,
  accent: cliTheme.accent.primary,
  success: cliTheme.semantic.success,
  warning: cliTheme.semantic.warning,
  error: cliTheme.semantic.error,
};

/**
 * A compact pill: a label on a subtle filled surface, colored by tone. Used for
 * mode/permission/count indicators so they read as one consistent family.
 */
export function Badge({ tone = "neutral", label }: { tone?: BadgeTone; label: string }) {
  return (
    <box backgroundColor={cliTheme.overlay.badgeBackground} paddingX={1}>
      <text fg={toneColor[tone]}>{label}</text>
    </box>
  );
}
