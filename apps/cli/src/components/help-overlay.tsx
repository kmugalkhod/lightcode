import { keymap, type KeyBinding } from "../commands/keymap";
import { typeRole, borderStyleFor, cliTheme } from "../ui/cli-theme";

const screenHints: Array<{ context: string; hint: string }> = [
  { context: "Chat", hint: "Tab/Ctrl+T switch mode | @ attach files | /compact, /undo actions" },
  { context: "Chat", hint: "Ctrl+O expand tool output | Ctrl+R show reasoning | Enter send | Ctrl+Enter newline" },
  { context: "IDE", hint: "F2 IDE layout (Explorer · Editor · Chat) | Tab focus Explorer | →/Enter open file | click ✎ or e to edit, Ctrl+S save | [ ] tabs" },
  { context: "Copy", hint: "Ctrl+Y copy mode (↑/↓ pick, Enter copy, c code) | /copy [last|code|all]" },
  { context: "Sessions", hint: "Enter resume | r rename | f fork | / filter | e export (.md) | d delete" },
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
        {screenHints.map((entry, index) => (
          <box key={`${entry.context}-${index}`} flexDirection="row">
            <text {...typeRole("label")}>{entry.context.padEnd(10)}</text>
            <text {...typeRole("secondary")}>{entry.hint}</text>
          </box>
        ))}
      </box>

      <text {...typeRole("caption")}>Esc or F1 to close</text>
    </box>
  );
}
