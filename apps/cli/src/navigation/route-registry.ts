import type { ReactNode } from "react";
import type { RouteStateByView, ViewId } from "./route-state";
import { ChatScreen } from "../screens/chat-screen";
import { HomeScreen } from "../screens/home-screen";

export interface ScreenProps<K extends ViewId> {
  routeState: RouteStateByView[K];
}

export type ScreenComponent<K extends ViewId> = (props: ScreenProps<K>) => ReactNode;

export interface RouteDefinition<K extends ViewId> {
  id: K;
  label: string;
  description: string;
  path: string;
  shortcut: string;
  component: ScreenComponent<K>;
  hidden?: boolean;
}

export type AnyRouteDefinition = {
  [K in ViewId]: RouteDefinition<K>;
}[ViewId];

export const routeRegistry: AnyRouteDefinition[] = [
  { id: "home", label: "Home", description: "Open home", path: "/home", shortcut: "/home", component: HomeScreen },
  { id: "chat", label: "Chat", description: "Open chat", path: "/chat", shortcut: "/chat", component: ChatScreen, hidden: true },
];

export function getRoute(id: ViewId): AnyRouteDefinition | undefined {
  return routeRegistry.find((route) => route.id === id);
}

export function getRouteByShortcut(shortcut: string): AnyRouteDefinition | undefined {
  return routeRegistry.find((route) => route.shortcut === shortcut);
}

export function getNavigationRoutes(): AnyRouteDefinition[] {
  return routeRegistry.filter((route) => !route.hidden);
}

export function getSlashPageRoutes(query = ""): AnyRouteDefinition[] {
  const normalizedQuery = query.trim().replace(/^\//, "").toLowerCase();

  return getNavigationRoutes().filter((route) => {
    if (route.id === "home") {
      return false;
    }

    if (!normalizedQuery) {
      return true;
    }

    return (
      route.path.toLowerCase().includes(normalizedQuery) ||
      route.label.toLowerCase().includes(normalizedQuery) ||
      route.description.toLowerCase().includes(normalizedQuery)
    );
  });
}

export function isViewId(id: string): id is ViewId {
  return routeRegistry.some((route) => route.id === id);
}

export function getViewIdFromAction(action: string): ViewId | undefined {
  if (!action.startsWith("nav:")) {
    return undefined;
  }

  const id = action.slice("nav:".length);
  return isViewId(id) ? id : undefined;
}
