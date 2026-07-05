import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { PermissionMode } from "@lightcode/ai";
import { useEffect, useState } from "react";
import { isDownKey, isEnterKey, isEscapeKey, isUpKey } from "../../utils/key-utils";
import { borderStyleFor, cliTheme, getOverlayRowColors } from "../../ui/cli-theme";
import { activeGlyphs } from "../../ui/cli-theme-capabilities";

interface PermissionModeSelectorProps {
  currentMode: PermissionMode | undefined;
  onSelect: (mode: PermissionMode) => void;
  onClose: () => void;
}

const permissionModes: Array<{
  mode: PermissionMode;
  label: string;
  description: string;
  risks: string[];
}> = [
  {
    mode: "read-only",
    label: "Read Only",
    description: "Safe mode for reading and analyzing code",
    risks: ["No file modifications", "No shell execution"],
  },
  {
    mode: "workspace-write",
    label: "Workspace Write",
    description: "Edit and create files (asks for dangerous ops)",
    risks: ["File edits allowed", "Requests approval for bash commands"],
  },
  {
    mode: "danger-full-access",
    label: "Danger: Full Access",
    description: "Unrestricted access to all tools",
    risks: ["All file operations", "Shell execution", "No confirmation"],
  },
];

export function PermissionModeSelector({
  currentMode,
  onSelect,
  onClose,
}: PermissionModeSelectorProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    // Initialize selection to current mode
    if (currentMode) {
      const currentIndex = permissionModes.findIndex((m) => m.mode === currentMode);
      if (currentIndex >= 0) {
        setSelectedIndex(currentIndex);
      }
    }
  }, [currentMode]);

  useKeyboard((keyEvent) => {
    const keyName = keyEvent.name.toLowerCase();

    if (isEscapeKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      onClose();
      return;
    }

    if (keyName === "tab" || keyEvent.sequence === "\t") {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      // Tab cycles through the modes, wrapping back to the first.
      setSelectedIndex((current) =>
        keyEvent.shift
          ? (current - 1 + permissionModes.length) % permissionModes.length
          : (current + 1) % permissionModes.length,
      );
      return;
    }

    if (isDownKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      setSelectedIndex((current) => Math.min(current + 1, permissionModes.length - 1));
      return;
    }

    if (isUpKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      setSelectedIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (isEnterKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      onSelect(permissionModes[selectedIndex].mode);
      return;
    }
  });

  const currentSelection = permissionModes[selectedIndex];

  return (
    <box
      width="100%"
      flexDirection="column"
      borderStyle={borderStyleFor.modal}
      borderColor={cliTheme.overlay.border}
      backgroundColor={cliTheme.overlay.surface}
    >
      {/* Header */}
      <box
        width="100%"
        flexDirection="row"
        justifyContent="space-between"
        paddingX={2}
        paddingY={1}
        borderStyle="single"
        border={["bottom"]}
        borderColor={cliTheme.overlay.border}
      >
        <text fg={cliTheme.accent.primary} attributes={TextAttributes.BOLD}>
          Permission Mode
        </text>
        <text fg={cliTheme.overlay.footerText}>
          Tab/↑/↓ select · Enter confirm · Esc cancel
        </text>
      </box>

      {/* Mode Options */}
      <box flexDirection="column" paddingY={1}>
        {permissionModes.map((modeOption, index) => {
          const isSelected = index === selectedIndex;
          const rowColors = getOverlayRowColors(isSelected);

          return (
            <box
              key={modeOption.mode}
              width="100%"
              flexDirection="column"
              paddingX={2}
              paddingY={1}
              backgroundColor={rowColors.backgroundColor}
            >
              <box width="100%" flexDirection="row" alignItems="center">
                <text
                  width={3}
                  fg={
                    isSelected
                      ? cliTheme.accent.primary
                      : cliTheme.text.muted
                  }
                  attributes={TextAttributes.BOLD}
                >
                  {isSelected ? `${activeGlyphs.roleUser} ` : "  "}
                </text>
                <text
                  fg={
                    isSelected
                      ? cliTheme.overlay.selectedRowText
                      : cliTheme.text.primary
                  }
                  attributes={isSelected ? TextAttributes.BOLD : TextAttributes.NONE}
                >
                  {modeOption.label}
                </text>
                {modeOption.mode === currentMode && (
                  <text
                    fg={cliTheme.accent.primary}
                    marginLeft={2}
                  >
                    (current)
                  </text>
                )}
              </box>
              <text
                fg={
                  isSelected
                    ? cliTheme.overlay.selectedRowText
                    : cliTheme.overlay.description
                }
                marginLeft={3}
              >
                {modeOption.description}
              </text>
              <box flexDirection="row" gap={3} marginLeft={3} marginTop={1}>
                {modeOption.risks.map((risk) => (
                  <text
                    key={risk}
                    fg={
                      modeOption.mode === "danger-full-access"
                        ? cliTheme.semantic.error
                        : cliTheme.text.muted
                    }
                    attributes={TextAttributes.DIM}
                  >
                    {activeGlyphs.bullet} {risk}
                  </text>
                ))}
              </box>
            </box>
          );
        })}
      </box>

      {/* Current Selection Detail */}
      <box
        width="100%"
        flexDirection="column"
        paddingX={2}
        paddingY={1}
        borderStyle="single"
        border={["top"]}
        borderColor={cliTheme.overlay.border}
        backgroundColor={cliTheme.overlay.selectedRowBackground}
      >
        <text fg={cliTheme.overlay.selectedRowText} attributes={TextAttributes.BOLD}>
          Selected: {currentSelection.label}
        </text>
        <text fg={cliTheme.overlay.selectedRowText}>
          {currentSelection.mode === "danger-full-access"
            ? "⚠ This grants unrestricted access. Use with caution!"
            : "Press Enter to switch to this permission level."}
        </text>
      </box>
    </box>
  );
}
