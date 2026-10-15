import {
  contextHelpLine,
  contextKeyHints,
  contextKeyLabels,
  type KeyContext,
} from "../commands/context-keys";
import { keymap, type KeyBinding } from "../commands/keymap";
import { typeRole, borderStyleFor, cliTheme } from "../ui/cli-theme";

function formatSequence(binding: KeyBinding): string {
  return binding.shortcutLabel ?? binding.sequence.toUpperCase();
}

export function HelpOverlay() {
  // Aliases (e.g. Ctrl+_ for Ctrl+/) share a label; list each shortcut once.
  const seen = new Set<string>();
  const bindings = Object.values(keymap.bindings).filter((binding) => {
    const key = `${formatSequence(binding)}|${binding.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return (
    <box
      width="100%"
      flexDirection="column"
      borderStyle={borderStyleFor.modal}
      borderColor={cliTheme.accent.primary}
      backgroundColor={cliTheme.overlay.surface}
      paddingX={2}
      paddingY={1}
      gap={1}
    >
      <text {...typeRole("display")}>Keyboard reference</text>

      <box flexDirection="column">
        {bindings.map((binding) => (
          <box key={binding.sequence} flexDirection="row">
            <text {...typeRole("label")}>{formatSequence(binding).padEnd(10)}</text>
            <text {...typeRole("body")}>{binding.label}</text>
          </box>
        ))}
      </box>

      <box flexDirection="column">
        {(Object.keys(contextKeyHints) as KeyContext[]).map((context) => (
          <box key={context} flexDirection="row">
            <text {...typeRole("label")}>{contextKeyLabels[context].padEnd(10)}</text>
            <text {...typeRole("secondary")}>{contextHelpLine(context)}</text>
          </box>
        ))}
      </box>

      <text {...typeRole("caption")}>Esc or F1 to close</text>
    </box>
  );
}
