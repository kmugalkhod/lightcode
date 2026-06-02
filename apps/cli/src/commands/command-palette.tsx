import { TextAttributes } from "@opentui/core";
import { searchCommands, type Command } from "./command-registry";
import { cliTheme } from "../ui/cli-theme";

interface CommandPaletteProps {
  query: string;
  setQuery: (q: string) => void;
  selectedIndex: number;
}

const INDICATOR_SELECTED = ">";
const INDICATOR_DEFAULT = " ";

export function CommandPalette({ query, setQuery, selectedIndex }: CommandPaletteProps) {
  const commands: Command[] = searchCommands(query.trim());
  const totalCommands = 12; // Total available commands (approximate)

  return (
    <box
      position="absolute"
      left="25%"
      top="25%"
      width="50%"
      minHeight={20}
      flexDirection="column"
      backgroundColor={cliTheme.overlay.surface}
      borderStyle="single"
      border={["top", "bottom", "left", "right"]}
      borderColor={cliTheme.overlay.border}
    >
      {/* Header */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        paddingX={2}
        paddingY={1}
        borderStyle="single"
        border={["bottom"]}
        borderColor={cliTheme.overlay.border}
      >
        <box flexDirection="row" alignItems="center" gap={1}>
          <text fg={cliTheme.overlay.title} attributes={TextAttributes.BOLD}>
            Command Palette
          </text>
          <box
            backgroundColor={cliTheme.overlay.countBadge}
            paddingX={1}
            paddingY={0}
          >
            <text
              fg={cliTheme.overlay.footerText}
            >
              {commands.length}
            </text>
          </box>
        </box>
        {query.trim() && (
          <text fg={cliTheme.overlay.headerMuted}>
            filtered from {totalCommands}
          </text>
        )}
      </box>

      {/* Search Input */}
      <box
        paddingX={2}
        paddingY={1}
        borderStyle="single"
        border={["bottom"]}
        borderColor={cliTheme.overlay.border}
      >
        <input
          value={query}
          onChange={(value: string) => setQuery(value)}
          placeholder="Type a command to search..."
          width="100%"
          backgroundColor={cliTheme.overlay.inputSurface}
          textColor={cliTheme.overlay.inputText}
          placeholderColor={cliTheme.overlay.mutedText}
        />
      </box>

      {/* Command List */}
      <box flexDirection="column" flexGrow={1} paddingY={1}>
        {commands.length === 0 ? (
          <NoCommandsFound query={query.trim()} />
        ) : (
          commands.map((cmd, index) => (
            <CommandItem
              key={cmd.id}
              command={cmd}
              index={index}
              selected={index === selectedIndex}
            />
          ))
        )}
      </box>

      {/* Footer */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        paddingX={2}
        paddingY={1}
        borderStyle="single"
        border={["top"]}
        borderColor={cliTheme.overlay.border}
      >
        <box flexDirection="row" gap={2}>
          <PaletteHint text="Up/Down" description="navigate" />
          <PaletteHint text="Enter" description="run" />
          <PaletteHint text="Esc" description="close" />
        </box>
        <text
          fg={cliTheme.overlay.shortcutHint}
        >
          Ctrl+P to toggle
        </text>
      </box>
    </box>
  );
}

// Individual command item component
interface CommandItemProps {
  command: Command;
  index: number;
  selected: boolean;
}

function CommandItem({ command, index, selected }: CommandItemProps) {
  const rowColors = cliTheme.overlay;

  return (
    <box
      flexDirection="row"
      alignItems="center"
      paddingX={2}
      paddingY={1}
      backgroundColor={selected ? rowColors.selectedRowBackground : "transparent"}
    >
      {/* Selection Indicator */}
      <text
        width={2}
        fg={selected ? rowColors.selectedBorder : cliTheme.text.muted}
        attributes={selected ? TextAttributes.BOLD : TextAttributes.NONE}
      >
        {selected ? INDICATOR_SELECTED : INDICATOR_DEFAULT}
      </text>

      {/* Category Badge */}
      <box
        backgroundColor={rowColors.badgeBackground}
        paddingX={1}
        paddingY={0}
        marginRight={2}
        minWidth={8}
      >
        <text
          fg={rowColors.badgeText}
        >
          {command.category}
        </text>
      </box>

      {/* Command Label */}
      <text
        fg={selected ? rowColors.selectedRowText : cliTheme.text.primary}
        attributes={selected ? TextAttributes.BOLD : TextAttributes.NONE}
        flexGrow={1}
      >
        {command.label}
      </text>

      {/* Shortcut (if available) */}
      {command.shortcut && (
        <box
          backgroundColor={rowColors.badgeBackground}
          paddingX={1}
          paddingY={0}
          marginLeft={2}
        >
          <text
            fg={rowColors.badgeText}
          >
            {command.shortcut}
          </text>
        </box>
      )}

      {/* Action hint on selection */}
      {selected && (
        <box
          marginLeft={2}
          paddingX={1}
          paddingY={0}
          backgroundColor={rowColors.badgeBackground}
        >
          <text
            fg={cliTheme.accent.primary}
          >
            Enter
          </text>
        </box>
      )}
    </box>
  );
}

// Hint component for footer
interface PaletteHintProps {
  text: string;
  description: string;
}

function PaletteHint({ text, description }: PaletteHintProps) {
  return (
    <box flexDirection="row" gap={1} alignItems="center">
      <text
        fg={cliTheme.accent.primary}
        attributes={TextAttributes.BOLD}
      >
        {text}
      </text>
      <text
        fg={cliTheme.overlay.mutedText}
      >
        {description}
      </text>
    </box>
  );
}

// No commands found state
interface NoCommandsFoundProps {
  query: string;
}

function NoCommandsFound({ query }: NoCommandsFoundProps) {
  return (
    <box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      paddingY={3}
      paddingX={2}
    >
      <text fg={cliTheme.overlay.footerText} attributes={TextAttributes.BOLD}>
        No commands found
      </text>
      <box flexDirection="column" alignItems="center" marginTop={1}>
        <text fg={cliTheme.overlay.shortcutHint}>
          No results for "{query}"
        </text>
        <text
          fg={cliTheme.overlay.description}
          marginTop={1}
        >
          Try a different search term
        </text>
      </box>
    </box>
  );
}
