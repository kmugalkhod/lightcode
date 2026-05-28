import { TextAttributes } from "@opentui/core";
import { getLeaderBindings } from "./keymap";
import { cliTheme } from "../ui/cli-theme";

export function WhichKey() {
  const bindings = getLeaderBindings();

  return (
    <box
      position="absolute"
      left="40%"
      top="40%"
      width="20%"
      flexDirection="column"
      backgroundColor={cliTheme.overlay.surface}
      borderStyle="single"
      border={["top", "bottom", "left", "right"]}
      borderColor={cliTheme.overlay.border}
    >
      <box
        paddingX={1}
        paddingY={1}
        borderStyle="single"
        border={["bottom"]}
        borderColor={cliTheme.overlay.border}
      >
        <text fg={cliTheme.overlay.title} attributes={TextAttributes.BOLD}>
          Leader Key Menu
        </text>
      </box>
      <box flexDirection="column" flexGrow={1} padding={1}>
        {bindings.map((binding) => (
          <box key={binding.sequence} flexDirection="row" justifyContent="space-between" paddingX={1}>
            <text fg={cliTheme.text.primary}>
              {binding.label}
            </text>
            <text fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
              {binding.sequence}
            </text>
          </box>
        ))}
      </box>
      <box
        paddingX={1}
        paddingY={1}
        borderStyle="single"
        border={["top"]}
        borderColor={cliTheme.overlay.border}
      >
        <text fg={cliTheme.overlay.footerText} attributes={TextAttributes.DIM}>
          Press key or Esc to cancel
        </text>
      </box>
    </box>
  );
}
