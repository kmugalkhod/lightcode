export interface KeyBinding {
  sequence: string;
  action: string;
  label: string;
  category: "navigation" | "system" | "action";
}

export interface KeymapConfig {
  leader: string;
  leader_timeout: number;
  bindings: Record<string, KeyBinding>;
}

export const keymap: KeymapConfig = {
  leader: "",
  leader_timeout: 2000,
  bindings: {
    "/": { sequence: "/", action: "system:slashPalette", label: "Slash Commands", category: "system" },
    "ctrl+p": { sequence: "ctrl+p", action: "system:palette", label: "Command Palette", category: "system" },
    "ctrl+h": { sequence: "ctrl+h", action: "system:back", label: "Go Back", category: "system" },
    "ctrl+[": { sequence: "ctrl+[", action: "system:popLayer", label: "Close Layer", category: "system" },
    "q": { sequence: "q", action: "system:quit", label: "Quit", category: "system" },
    "escape": { sequence: "escape", action: "system:cancel", label: "Cancel", category: "system" },
    "ctrl+c": { sequence: "ctrl+c", action: "system:quit", label: "Quit", category: "system" },
  },
};

export function getBinding(sequence: string): KeyBinding | undefined {
  return keymap.bindings[sequence];
}

export function getLeaderBindings(): KeyBinding[] {
  if (!keymap.leader) {
    return [];
  }

  return Object.values(keymap.bindings).filter(
    (b) => b.sequence.startsWith(keymap.leader)
  );
}

export function isLeaderKey(key: string): boolean {
  return key === keymap.leader;
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
