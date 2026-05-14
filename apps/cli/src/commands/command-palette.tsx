import { TextAttributes } from "@opentui/core";
import { searchCommands, type Command } from "./command-registry";

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
      backgroundColor="#1E1E1E"
      borderStyle="single"
      border={["top", "bottom", "left", "right"]}
    >
      <box paddingX={1} paddingY={1} borderStyle="single" border={["bottom"]}>
        <text fg="#67E8F9" attributes={TextAttributes.BOLD}>
          Command Palette
        </text>
      </box>
      <box flexDirection="column" flexGrow={1} padding={1}>
        <input
          value={query}
          onChange={(value: string) => setQuery(value)}
          placeholder="Type a command..."
          width="100%"
          backgroundColor="#2D2D2D"
          textColor="#FFFFFF"
        />
        <box flexDirection="column" flexGrow={1} marginTop={1}>
          {commands.map((cmd, index) => (
            <box
              key={cmd.id}
              flexDirection="row"
              justifyContent="space-between"
              paddingX={1}
              backgroundColor={
                index === selectedIndex ? "#3D3D3D" : "transparent"
              }
            >
              <text
                fg={index === selectedIndex ? "#67E8F9" : "#FFFFFF"}
              >
                {cmd.label}
              </text>
              <text attributes={TextAttributes.DIM}>
                {cmd.shortcut || cmd.category}
              </text>
            </box>
          ))}
        </box>
      </box>
      <box paddingX={1} paddingY={1} borderStyle="single" border={["top"]}>
        <text attributes={TextAttributes.DIM}>
          Up/Down or j/k navigate | Enter select | Esc close
        </text>
      </box>
    </box>
  );
}
