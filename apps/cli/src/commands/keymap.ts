export interface KeyBinding {
  sequence: string;
  action: string;
  label: string;
  category: "navigation" | "system" | "action";
  shortcutLabel?: string;
}

export interface KeymapConfig {
  bindings: Record<string, KeyBinding>;
}

export const BACK_SHORTCUT_LABEL = "Ctrl+G";

export const keymap: KeymapConfig = {
  bindings: {
    "/": { sequence: "/", action: "system:slashPalette", label: "Slash Commands", category: "system" },
    "ctrl+p": { sequence: "ctrl+p", action: "system:palette", label: "Command Palette", category: "system" },
    "ctrl+g": { sequence: "ctrl+g", action: "system:back", label: "Go Back", category: "system", shortcutLabel: BACK_SHORTCUT_LABEL },
    // Quit is Ctrl+C/Ctrl+Q only: a bare "q" (or Esc) quitting the whole TUI
    // while typing or browsing is a footgun.
    "ctrl+c": { sequence: "ctrl+c", action: "system:quit", label: "Quit", category: "system" },
    "ctrl+q": { sequence: "ctrl+q", action: "system:quit", label: "Quit", category: "system" },
    "f1": { sequence: "f1", action: "system:help", label: "Help", category: "system" },
    "ctrl+/": { sequence: "ctrl+/", action: "system:help", label: "Help", category: "system" },
    "ctrl+o": { sequence: "ctrl+o", action: "system:toggleToolOutput", label: "Expand Tool Output", category: "action" },
    "ctrl+r": { sequence: "ctrl+r", action: "system:toggleReasoning", label: "Show Reasoning", category: "action" },
  },
};

export function getBinding(sequence: string): KeyBinding | undefined {
  return keymap.bindings[sequence];
}

export function normalizeKeyName(key: string, ctrl: boolean, shift: boolean, alt: boolean): string {
  let normalized = key.toLowerCase();

  if (normalized === "slash") {
    normalized = "/";
  }

  if (ctrl) normalized = `ctrl+${normalized}`;
  if (shift && !normalized.startsWith("ctrl+")) normalized = `shift+${normalized}`;
  if (alt && !normalized.startsWith("ctrl+")) normalized = `alt+${normalized}`;

  return normalized;
}
