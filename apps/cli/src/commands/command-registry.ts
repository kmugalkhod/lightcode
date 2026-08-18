import { keymap } from "./keymap";
import { getNavigationRoutes } from "../navigation/route-registry";
import { chatSlashActions } from "./chat-slash-actions";

export type CommandHost = "chat" | "home" | "other";

export interface Command {
  id: string;
  label: string;
  description?: string;
  category: "navigation" | "action" | "system";
  shortcut?: string;
  /** Screens where this command is useful. Omitted commands are global. */
  availableOn?: readonly CommandHost[];
}

const navigationCommands: Command[] = getNavigationRoutes().map((route) => ({
  id: `nav:${route.id}`,
  label: route.label,
  description: route.description,
  category: "navigation",
  shortcut: route.shortcut,
}));

const chatActionCommands: Command[] = chatSlashActions.map((action) => ({
  id: `chat:${action.id}`,
  label: action.label,
  description: action.description,
  category: "action",
  shortcut: action.shortcut,
  availableOn: action.availableOnHome
    ? (["chat", "home"] as const)
    : (["chat"] as const),
}));

// A single action can have multiple bindings (Help uses F1 and Ctrl+/; Quit
// uses Ctrl+C and Ctrl+Q). Keep one discoverable command and show every key.
const systemCommands: Command[] = Array.from(
  Object.values(keymap.bindings)
    .filter((binding) => binding.category !== "navigation")
    .reduce((commands, binding) => {
      const shortcut = binding.shortcutLabel ?? binding.sequence;
      const existing = commands.get(binding.action);

      if (existing) {
        existing.shortcut = existing.shortcut
          ? `${existing.shortcut} / ${shortcut}`
          : shortcut;
        return commands;
      }

      commands.set(binding.action, {
        id: binding.action,
        label: binding.label,
        category: binding.category,
        shortcut,
      });
      return commands;
    }, new Map<string, Command>())
    .values(),
);

export const commandRegistry: Command[] = [
  ...navigationCommands,
  ...chatActionCommands,
  ...systemCommands,
];

export function getCommands(host: CommandHost): Command[] {
  return commandRegistry.filter(
    (command) => !command.availableOn || command.availableOn.includes(host),
  );
}

export function searchCommands(query: string, host: CommandHost): Command[] {
  const lower = query.trim().toLowerCase();
  return getCommands(host).filter(
    (command) =>
      command.label.toLowerCase().includes(lower) ||
      command.description?.toLowerCase().includes(lower) ||
      command.id.toLowerCase().includes(lower) ||
      command.shortcut?.toLowerCase().includes(lower),
  );
}

export function clampCommandSelection(
  selectedIndex: number,
  resultCount: number,
): number {
  if (resultCount <= 0) {
    return 0;
  }

  return Math.min(Math.max(selectedIndex, 0), resultCount - 1);
}
