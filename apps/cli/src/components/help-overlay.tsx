import { TextAttributes } from "@opentui/core";
import { keymap, type KeyBinding } from "../commands/keymap";
import { cliTheme } from "../ui/cli-theme";

const screenHints: Array<{ context: string; hint: string }> = [
  { context: "Chat", hint: "Tab/Ctrl+T switch mode | @ attach files | /compact, /undo actions" },
  { context: "Chat", hint: "Ctrl+O expand tool output | Enter send | Ctrl+Enter newline" },
  { context: "Sessions", hint: "Enter resume | r rename | f fork | / filter | e export | d delete" },
];

function formatSequence(binding: KeyBinding): string {
  return binding.shortcutLabel ?? binding.sequence.toUpperCase();
}

export function HelpOverlay() {
  const bindings = Object.values(keymap.bindings);

  return (
    <box
      width="100%"
      flexDirection="column"
      borderStyle="single"
      borderColor={cliTheme.accent.primary}
      backgroundColor={cliTheme.overlay.surface}
      paddingX={2}
      paddingY={1}
      gap={1}
    >
      <text fg={cliTheme.accent.primary} attributes={TextAttributes.BOLD}>
        Keyboard reference
      </text>

      <box flexDirection="column">
        {bindings.map((binding) => (
          <box key={binding.sequence} flexDirection="row">
            <text fg={cliTheme.accent.softText} attributes={TextAttributes.BOLD}>
              {formatSequence(binding).padEnd(10)}
            </text>
            <text fg={cliTheme.text.secondary}>{binding.label}</text>
          </box>
        ))}
      </box>

      <box flexDirection="column">
        {screenHints.map((entry, index) => (
          <box key={`${entry.context}-${index}`} flexDirection="row">
            <text fg={cliTheme.text.muted} attributes={TextAttributes.BOLD}>
              {entry.context.padEnd(10)}
            </text>
            <text fg={cliTheme.text.muted}>{entry.hint}</text>
          </box>
        ))}
      </box>

      <text fg={cliTheme.overlay.footerText} attributes={TextAttributes.DIM}>
        Esc or F1 to close
      </text>
    </box>
  );
}
