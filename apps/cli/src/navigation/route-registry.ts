export interface RouteDefinition {
  id:
    | "home"
    | "status"
    | "doctor"
    | "permissions"
    | "sessions"
    | "tools"
    | "config"
    | "model"
    | "model-select"
    | "latest-session";
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
  {
    id: "status",
    label: "Status",
    description: "Show server, session, model, DB, and tool status",
    path: "/status",
    shortcut: "/status",
  },
  {
    id: "doctor",
    label: "Doctor",
    description: "Run operational health checks",
    path: "/doctor",
    shortcut: "/doctor",
  },
  {
    id: "permissions",
    label: "Permissions",
    description: "Show permission mode, rules, allowed tools, and sandbox",
    path: "/permissions",
    shortcut: "/permissions",
  },
  {
    id: "sessions",
    label: "Sessions",
    description: "List saved sessions",
    path: "/sessions",
    shortcut: "/sessions",
  },
  {
    id: "tools",
    label: "Tools",
    description: "List tools, permission requirements, and schema status",
    path: "/tools",
    shortcut: "/tools",
  },
  {
    id: "config",
    label: "Config",
    description: "Show effective config without secrets",
    path: "/config",
    shortcut: "/config",
  },
  {
    id: "model-select",
    label: "Switch Model",
    description: "Pick any OpenRouter model; applies immediately and persists to settings.json",
    path: "/model",
    shortcut: "/model",
  },
  {
    id: "model",
    label: "Model Info",
    description: "Show provider, model, base URL, and key hints",
    path: "/model-info",
    shortcut: "/model-info",
  },
  {
    id: "latest-session",
    label: "Resume Latest",
    description: "Resume the latest saved session",
    path: "/sessions/latest",
    shortcut: "/latest",
  },
];

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
