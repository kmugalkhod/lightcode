import { useState, useEffect } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import { Dialog } from "./dialog";
import { cliTheme } from "./cli-theme";

interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

interface DialogSelectProps {
  title: string;
  options: SelectOption[];
  onSelect: (value: string) => void;
  onClose: () => void;
}

const INDICATOR_SELECTED = ">";
const INDICATOR_DEFAULT = " ";

export function DialogSelect({
  title,
  options,
  onSelect,
  onClose,
}: DialogSelectProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filter, setFilter] = useState("");

  const filteredOptions = filter.trim()
    ? options.filter((opt) =>
        opt.label.toLowerCase().includes(filter.toLowerCase()) ||
        opt.value.toLowerCase().includes(filter.toLowerCase())
      )
    : options;

  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  useKeyboard((keyEvent) => {
    if (keyEvent.name === "ArrowDown" || keyEvent.name === "j") {
      setSelectedIndex((i) => Math.min(i + 1, filteredOptions.length - 1));
    } else if (keyEvent.name === "ArrowUp" || keyEvent.name === "k") {
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (keyEvent.name === "Enter") {
      if (filteredOptions[selectedIndex]) {
        onSelect(filteredOptions[selectedIndex].value);
      }
    } else if (keyEvent.name === "Escape") {
      onClose();
    }
  });

  return (
    <Dialog title={title} width={70} height={15} onClose={onClose}>
      <box flexDirection="column" flexGrow={1}>
        {/* Search Input */}
        <box
          marginBottom={1}
          borderStyle="single"
          border={["bottom"]}
          borderColor={cliTheme.overlay.border}
          paddingBottom={1}
        >
          <input
            value={filter}
            onChange={(value: string) => setFilter(value || "")}
            placeholder="Search options..."
            width="100%"
            backgroundColor={cliTheme.overlay.inputSurface}
            textColor={cliTheme.overlay.inputText}
            placeholderColor={cliTheme.overlay.mutedText}
          />
        </box>

        {/* Options List */}
        <box flexDirection="column" flexGrow={1}>
          {filteredOptions.length === 0 ? (
            <NoOptionsFound query={filter} />
          ) : (
            filteredOptions.map((opt, index) => (
              <SelectOptionItem
                key={opt.value}
                option={opt}
                index={index}
                selected={index === selectedIndex}
              />
            ))
          )}
        </box>

        {/* Footer Hint */}
        <box
          flexDirection="row"
          justifyContent="space-between"
          alignItems="center"
          marginTop={1}
          paddingTop={1}
          borderStyle="single"
          border={["top"]}
          borderColor={cliTheme.overlay.border}
        >
          <box flexDirection="row" gap={2}>
            <SelectHint text="Up/Down" description="navigate" />
            <SelectHint text="Enter" description="select" />
            <SelectHint text="Esc" description="cancel" />
          </box>
          <text
            fg={cliTheme.overlay.shortcutHint}
          >
            {filteredOptions.length} of {options.length} options
          </text>
        </box>
      </box>
    </Dialog>
  );
}

// Individual option item component
interface SelectOptionItemProps {
  option: SelectOption;
  index: number;
  selected: boolean;
}

function SelectOptionItem({ option, index, selected }: SelectOptionItemProps) {
  const rowColors = cliTheme.overlay;

  return (
    <box
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      backgroundColor={selected ? rowColors.selectedRowBackground : "transparent"}
    >
      <box flexDirection="row" alignItems="center">
        {/* Selection Indicator */}
        <text
          width={2}
          fg={selected ? rowColors.selectedBorder : cliTheme.text.muted}
          attributes={selected ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {selected ? INDICATOR_SELECTED : INDICATOR_DEFAULT}
        </text>

        {/* Option Label */}
        <text
          fg={selected ? rowColors.selectedRowText : cliTheme.text.primary}
          attributes={selected ? TextAttributes.BOLD : TextAttributes.NONE}
          flexGrow={1}
        >
          {option.label}
        </text>

        {/* Selected indicator badge */}
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

      {/* Description (if available) */}
      {option.description && (
        <box flexDirection="row" paddingLeft={2} marginTop={0}>
          <text
            fg={rowColors.description}
          >
            {option.description}
          </text>
        </box>
      )}
    </box>
  );
}

// Hint component for footer
interface SelectHintProps {
  text: string;
  description: string;
}

function SelectHint({ text, description }: SelectHintProps) {
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

// No options found state
interface NoOptionsFoundProps {
  query: string;
}

function NoOptionsFound({ query }: NoOptionsFoundProps) {
  return (
    <box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      flexGrow={1}
      paddingY={2}
    >
      <text fg={cliTheme.overlay.footerText} attributes={TextAttributes.BOLD}>
        No options found
      </text>
      <text
        fg={cliTheme.overlay.shortcutHint}
        marginTop={1}
      >
        No results for "{query}"
      </text>
    </box>
  );
}
