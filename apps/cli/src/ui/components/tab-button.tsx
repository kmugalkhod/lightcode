import { useState } from "react";
import { borderStyleFor, cliTheme, typeRole } from "../cli-theme";

export function TabButton({
  label,
  active,
  onPress,
  underline = false,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  /** Editor-tab styling: an accent underline marks the active tab (IDE header). */
  underline?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <box
      paddingX={1}
      backgroundColor={
        active
          ? cliTheme.accent.softBackground
          : hovered
            ? cliTheme.overlay.hoverBackground
            : "transparent"
      }
      borderStyle={underline ? borderStyleFor.chrome : undefined}
      border={underline ? ["bottom"] : undefined}
      borderColor={
        underline
          ? active
            ? cliTheme.accent.primary
            : cliTheme.surfaces.panel
          : undefined
      }
      onMouseDown={onPress}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <text
        wrapMode="none"
        truncate
        fg={active ? cliTheme.accent.primary : cliTheme.text.muted}
        attributes={active ? typeRole("section").attributes : undefined}
      >
        {label}
      </text>
    </box>
  );
}

// ── Changes tab rows ─────────────────────────────────────────────────────────
