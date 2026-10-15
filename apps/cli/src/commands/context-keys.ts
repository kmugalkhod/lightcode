/**
 * Keys that only apply in one part of the UI. The one-line hint under the
 * input and the F1 help overlay both read from here, so they cannot drift.
 * Global bindings (F1, Ctrl+P, …) live in the keymap instead.
 */
export type KeyContext =
  | "chat"
  | "ide"
  | "explorer"
  | "changes"
  | "copy"
  | "slash"
  | "approval"
  | "sessions";

export interface ContextKeyHint {
  keys: string;
  label: string;
  /** Shown in the one-line hint; everything appears in F1 help. */
  primary?: boolean;
}

export const contextKeyLabels: Record<KeyContext, string> = {
  chat: "Chat",
  ide: "IDE",
  explorer: "Explorer",
  changes: "Changes",
  copy: "Copy",
  slash: "Commands",
  approval: "Approval",
  sessions: "Sessions",
};

export const contextKeyHints: Record<KeyContext, readonly ContextKeyHint[]> = {
  chat: [
    { keys: "Enter", label: "send", primary: true },
    { keys: "Shift+Enter", label: "newline", primary: true },
    { keys: "Tab/Ctrl+T", label: "switch mode" },
    { keys: "@", label: "attach files" },
    { keys: "Ctrl+O", label: "expand tool output" },
    { keys: "Ctrl+R", label: "show reasoning" },
    { keys: "Ctrl+Y", label: "copy mode" },
    { keys: "F2", label: "files & changes" },
  ],
  ide: [
    { keys: "Enter", label: "send", primary: true },
    { keys: "Tab", label: "explorer", primary: true },
    { keys: "Ctrl+T", label: "switch mode" },
    { keys: "F2", label: "exit IDE", primary: true },
  ],
  explorer: [
    { keys: "↑/↓", label: "move", primary: true },
    { keys: "Enter", label: "open", primary: true },
    { keys: "e", label: "edit", primary: true },
    { keys: "Ctrl+S", label: "save while editing" },
    { keys: "d", label: "diff/content" },
    { keys: "[ ]", label: "switch tabs" },
    { keys: "w", label: "close tab" },
    { keys: "Tab", label: "changes", primary: true },
    { keys: "Esc", label: "back", primary: true },
  ],
  changes: [
    { keys: "↑/↓", label: "move", primary: true },
    { keys: "Enter", label: "diff", primary: true },
    { keys: "r", label: "refresh", primary: true },
    { keys: "Tab", label: "files", primary: true },
    { keys: "Esc", label: "back", primary: true },
  ],
  copy: [
    { keys: "↑/↓", label: "select", primary: true },
    { keys: "Enter", label: "copy", primary: true },
    { keys: "c", label: "copy code", primary: true },
    { keys: "Esc", label: "exit", primary: true },
    { keys: "/copy", label: "last|code|all" },
  ],
  slash: [
    { keys: "↑/↓", label: "select", primary: true },
    { keys: "Enter", label: "open", primary: true },
    { keys: "Esc", label: "close", primary: true },
  ],
  approval: [
    { keys: "Enter", label: "approve", primary: true },
    { keys: "deny", label: "type to reject", primary: true },
    { keys: "text", label: "or reply", primary: true },
  ],
  sessions: [
    { keys: "Enter", label: "resume", primary: true },
    { keys: "r", label: "rename", primary: true },
    { keys: "f", label: "fork", primary: true },
    { keys: "/", label: "filter", primary: true },
    { keys: "e", label: "export", primary: true },
    { keys: "d", label: "delete", primary: true },
    { keys: "u", label: "refresh", primary: true },
    { keys: "l", label: "resume latest (empty list)" },
  ],
};

function formatHint(hint: ContextKeyHint): string {
  return hint.keys === "text" ? hint.label : `${hint.keys} ${hint.label}`;
}

/** The single hint line for a context: its primary keys. */
export function contextHintLine(context: KeyContext): string {
  return contextKeyHints[context]
    .filter((hint) => hint.primary)
    .map(formatHint)
    .join(" · ");
}

/** Every key for a context, for the help overlay. */
export function contextHelpLine(context: KeyContext): string {
  return contextKeyHints[context].map(formatHint).join(" · ");
}
