import type { ReactNode } from "react";
import type { RouteState, ViewId } from "../state/app-state";
import { ChatScreen } from "../screens/chat-screen";
import { HomeScreen } from "../screens/home-screen";

export interface ScreenProps {
  routeState: RouteState;
}

export type ScreenComponent = (props: ScreenProps) => ReactNode;

export interface RouteDefinition {
  id: ViewId;
  label: string;
  description: string;
  path: string;
  shortcut: string;
  component: ScreenComponent;
  hidden?: boolean;
}

export const routeRegistry: RouteDefinition[] = [
  { id: "home", label: "Home", description: "Open home", path: "/home", shortcut: "/home", component: HomeScreen },
  { id: "chat", label: "Chat", description: "Open chat", path: "/chat", shortcut: "/chat", component: ChatScreen, hidden: true },
];

export function getRoute(id: ViewId): RouteDefinition | undefined {
  return routeRegistry.find((route) => route.id === id);
}

export function getRouteByShortcut(shortcut: string): RouteDefinition | undefined {
  return routeRegistry.find((route) => route.shortcut === shortcut);
}

export function getNavigationRoutes(): RouteDefinition[] {
  return routeRegistry.filter((route) => !route.hidden);
}

export function getSlashPageRoutes(query = ""): RouteDefinition[] {
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
