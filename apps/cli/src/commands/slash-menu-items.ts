import {
  getSlashPageRoutes,
  type AnyRouteDefinition,
} from "../navigation/route-registry";
import {
  filterChatSlashActions,
  type ChatSlashActionDefinition,
} from "./chat-slash-actions";

/**
 * Entries selectable in the slash menu: navigation routes everywhere, plus
 * chat actions (e.g. /compact) when the menu is hosted by a chat session,
 * and the home-eligible subset (e.g. /permission) on the home screen.
 * Discriminate with `"path" in item` — only routes navigate.
 */
export type SlashMenuSelectable = AnyRouteDefinition | ChatSlashActionDefinition;

export type SlashMenuHost = "chat" | "home" | "other";

export function getSlashMenuItems(
  query: string,
  { host }: { host: SlashMenuHost },
): SlashMenuSelectable[] {
  const routes = getSlashPageRoutes(query);
  if (host === "other") {
    return routes;
  }

  const actions = filterChatSlashActions(query).filter(
    (action) => host === "chat" || action.availableOnHome,
  );

  // Actions win when a route shares the same shortcut, so the menu never
  // lists the same command twice.
  const seenShortcuts = new Set<string>();
  return [...actions, ...routes].filter((item) => {
    if (seenShortcuts.has(item.shortcut)) {
      return false;
    }
    seenShortcuts.add(item.shortcut);
    return true;
  });
}
