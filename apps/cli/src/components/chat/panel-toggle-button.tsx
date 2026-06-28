import { useState } from "react";
import { cliTheme, typeRole } from "../../ui/cli-theme";
import { terminalCapabilities } from "../../ui/cli-theme-capabilities";

const UNICODE = terminalCapabilities.unicode;

interface PanelToggleButtonProps {
  open: boolean;
  /** Number of changed files, shown as a small badge when > 0. */
  count: number;
  onToggle: () => void;
}

/**
 * A small clickable affordance in the chat header that toggles the right-side
 * Changes panel. Reads as a control: subtle surface, hover highlight, accent
 * when the panel is open, muted when closed. Mirrors F2.
 */
export function PanelToggleButton({ open, count, onToggle }: PanelToggleButtonProps) {
  const [hovered, setHovered] = useState(false);

  // Open uses a left-filled split glyph; closed uses the hollow variant.
  // ASCII terminals fall back to a +/- expand affordance.
  const icon = UNICODE ? (open ? "◧" : "◨") : open ? "[-]" : "[+]";
  const accent = open ? cliTheme.accent.primary : cliTheme.text.muted;
  const textColor = open || hovered ? cliTheme.text.primary : cliTheme.text.secondary;
  const background = open
    ? cliTheme.accent.softBackground
    : hovered
      ? cliTheme.overlay.hoverBackground
      : cliTheme.surfaces.elevated;

  return (
    <box
      flexDirection="row"
      alignItems="center"
      gap={1}
      paddingX={1}
      backgroundColor={background}
      onMouseDown={onToggle}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <text fg={accent}>{icon}</text>
      <text fg={textColor}>IDE</text>
      {count > 0 ? (
        <box backgroundColor={cliTheme.overlay.countBadge} paddingX={1}>
          <text fg={cliTheme.accent.softText}>{String(count)}</text>
        </box>
      ) : null}
      <text {...typeRole("caption")}>F2</text>
    </box>
  );
}
