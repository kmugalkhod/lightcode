import { cliTheme } from "../cli-theme";
import { activeGlyphs } from "../cli-theme-capabilities";

export type DotStatus = "online" | "degraded" | "offline" | "loading";

const dotColor: Record<DotStatus, string> = {
  online: cliTheme.semantic.success,
  degraded: cliTheme.semantic.warning,
  offline: cliTheme.semantic.error,
  loading: cliTheme.text.muted,
};

/**
 * A single status dot whose color carries meaning (the glyph stays constant, so
 * it reads the same on monochrome terminals via bold/position).
 */
export function StatusDot({ status }: { status: DotStatus }) {
  return <text fg={dotColor[status]}>{activeGlyphs.statusDot}</text>;
}
