import { TextAttributes } from "@opentui/core";
import { getLeaderBindings } from "./keymap";
import { cliTheme } from "../ui/cli-theme";

export function WhichKey() {
  const bindings = getLeaderBindings();

  return (
    <box
      position="absolute"
      left="35%"
      top="35%"
      width="30%"
      minHeight={12}
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
            Leader Key
          </text>
          <box
            backgroundColor={cliTheme.overlay.countBadge}
            paddingX={1}
            paddingY={0}
          >
            <text
              fg={cliTheme.overlay.footerText}
            >
              {bindings.length}
            </text>
          </box>
        </box>
        <text fg={cliTheme.overlay.headerMuted}>
          menu
        </text>
      </box>

      {/* Bindings List */}
      <box flexDirection="column" flexGrow={1} paddingY={1}>
        {bindings.map((binding, index) => (
          <KeyBindingItem
            key={binding.sequence}
            binding={binding}
            index={index}
          />
        ))}
      </box>

      {/* Footer */}
      <box
        flexDirection="row"
        justifyContent="center"
        alignItems="center"
        paddingX={2}
        paddingY={1}
        borderStyle="single"
        border={["top"]}
        borderColor={cliTheme.overlay.border}
      >
        <box flexDirection="row" gap={1} alignItems="center">
          <text
            fg={cliTheme.accent.primary}
            attributes={TextAttributes.BOLD}
          >
            Esc
          </text>
          <text
            fg={cliTheme.overlay.mutedText}
          >
            to cancel
          </text>
        </box>
      </box>
    </box>
  );
}

// Individual key binding item component
interface KeyBindingItemProps {
  binding: {
    label: string;
    sequence: string;
    description?: string;
  };
  index: number;
}

function KeyBindingItem({ binding }: KeyBindingItemProps) {
  const rowColors = cliTheme.overlay;

  // Parse sequence to show individual keys
  const keyParts = binding.sequence.split("").map((key) => key.toUpperCase());

  return (
    <box
      flexDirection="row"
      alignItems="center"
      paddingX={2}
      paddingY={1}
    >
      {/* Empty space for alignment */}
      <text width={2}></text>

      {/* Key Sequence Badges */}
      <box flexDirection="row" gap={0.5} marginRight={2}>
        {keyParts.map((key, idx) => (
          <box
            key={idx}
            backgroundColor={rowColors.badgeBackground}
            paddingX={1}
            paddingY={0}
            borderStyle="single"
            borderColor={rowColors.sectionDivider}
          >
            <text
              fg={cliTheme.accent.primary}
              attributes={TextAttributes.BOLD}
            >
              {key}
            </text>
          </box>
        ))}
      </box>

      {/* Label */}
      <text
        fg={cliTheme.text.primary}
        flexGrow={1}
      >
        {binding.label}
      </text>

      {/* Description (if available) */}
      {binding.description && (
        <text
          fg={rowColors.description}
          width={20}
        >
          {binding.description}
        </text>
      )}
    </box>
  );
}
