import { keymap } from "./keymap";
import { getNavigationRoutes } from "../navigation/route-registry";

export interface Command {
  id: string;
  label: string;
  category: "navigation" | "action" | "system";
  shortcut?: string;
}

const navigationCommands: Command[] = getNavigationRoutes().map((route) => ({
  id: `nav:${route.id}`,
  label: route.label,
  category: "navigation",
  shortcut: route.shortcut,
}));

const systemCommands: Command[] = Object.values(keymap.bindings)
  .filter((binding) => binding.category !== "navigation")
  .map((binding) => ({
    id: binding.action,
    label: binding.label,
    category: binding.category,
    shortcut: binding.shortcutLabel ?? binding.sequence,
  }));

export const commandRegistry: Command[] = [
  ...navigationCommands,
  ...systemCommands,
];

export function searchCommands(query: string): Command[] {
  const lower = query.toLowerCase();
  return commandRegistry.filter((cmd) =>
    cmd.label.toLowerCase().includes(lower) ||
    cmd.id.toLowerCase().includes(lower) ||
    cmd.shortcut?.toLowerCase().includes(lower)
  );
}
