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
 * chat actions (e.g. /compact) when the menu is hosted by a chat session.
 * Discriminate with `"path" in item` — only routes navigate.
 */
export type SlashMenuSelectable = AnyRouteDefinition | ChatSlashActionDefinition;

export function getSlashMenuItems(
  query: string,
  { includeChatActions }: { includeChatActions: boolean },
): SlashMenuSelectable[] {
  const routes = getSlashPageRoutes(query);
  if (!includeChatActions) {
    return routes;
  }

  return [...filterChatSlashActions(query), ...routes];
}
