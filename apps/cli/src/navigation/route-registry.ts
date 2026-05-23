export interface RouteDefinition {
  id: "home";
  label: string;
  description: string;
  path: string;
  shortcut: string;
  hidden?: boolean;
}

export type AnyRouteDefinition = RouteDefinition;

export const routeRegistry: AnyRouteDefinition[] = [
  {
    id: "home",
    label: "Home",
    description: "Open home",
    path: "/",
    shortcut: "/home",
  },
];

export function getRoute(id: RouteDefinition["id"]): AnyRouteDefinition | undefined {
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

  if (!normalizedQuery) {
    return getNavigationRoutes();
  }

  return getNavigationRoutes().filter((route) => {
    return (
      route.path.toLowerCase().includes(normalizedQuery) ||
      route.shortcut.replace(/^\//, "").toLowerCase().includes(normalizedQuery) ||
      route.label.toLowerCase().includes(normalizedQuery) ||
      route.description.toLowerCase().includes(normalizedQuery)
    );
  });
}

export function getPathFromAction(action: string): string | undefined {
  if (!action.startsWith("nav:")) {
    return undefined;
  }

  const id = action.slice("nav:".length);
  const route = routeRegistry.find((candidate) => candidate.id === id);
  return route?.path;
}
