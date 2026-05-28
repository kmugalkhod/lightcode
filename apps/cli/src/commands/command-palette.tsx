import { TextAttributes } from "@opentui/core";
import { searchCommands, type Command } from "./command-registry";
import { cliTheme, getOverlayRowColors } from "../ui/cli-theme";

interface CommandPaletteProps {
  query: string;
  setQuery: (q: string) => void;
  selectedIndex: number;
}

export function CommandPalette({ query, setQuery, selectedIndex }: CommandPaletteProps) {
  const commands: Command[] = searchCommands(query.trim());

  return (
    <box
      position="absolute"
      left="25%"
      top="30%"
      width="50%"
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
          Command Palette
        </text>
      </box>
      <box flexDirection="column" flexGrow={1} padding={1}>
        <input
          value={query}
          onChange={(value: string) => setQuery(value)}
          placeholder="Type a command..."
          width="100%"
          backgroundColor={cliTheme.overlay.inputSurface}
          textColor={cliTheme.overlay.inputText}
        />
        <box flexDirection="column" flexGrow={1} marginTop={1}>
          {commands.map((cmd, index) => {
            const rowColors = getOverlayRowColors(index === selectedIndex);

            return (
              <box
                key={cmd.id}
                flexDirection="row"
                justifyContent="space-between"
                paddingX={1}
                backgroundColor={rowColors.backgroundColor}
              >
                <text fg={rowColors.primaryTextColor}>
                  {cmd.label}
                </text>
                <text fg={rowColors.secondaryTextColor} attributes={TextAttributes.DIM}>
                  {cmd.shortcut || cmd.category}
                </text>
              </box>
            );
          })}
        </box>
      </box>
      <box
        paddingX={1}
        paddingY={1}
        borderStyle="single"
        border={["top"]}
        borderColor={cliTheme.overlay.border}
      >
        <text fg={cliTheme.overlay.footerText} attributes={TextAttributes.DIM}>
          Up/Down or j/k navigate | Enter select | Esc close
        </text>
      </box>
    </box>
  );
}
