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
    "q": { sequence: "q", action: "system:quit", label: "Quit", category: "system" },
    "ctrl+c": { sequence: "ctrl+c", action: "system:quit", label: "Quit", category: "system" },
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
