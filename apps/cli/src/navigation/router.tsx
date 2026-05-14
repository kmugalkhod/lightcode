import { getRoute } from "./route-registry";
import { coerceRouteState, type RouteState, type ViewId } from "./route-state";

interface RouterProps {
  currentView: ViewId;
  routeState: RouteState;
}

export function Router({ currentView, routeState }: RouterProps) {
  const route = getRoute(currentView);

  if (!route) {
    return null;
  }

  if (route.id === "home") {
    const Component = route.component;
    return <Component routeState={coerceRouteState("home", routeState)} />;
  }

  if (route.id === "chat") {
    const Component = route.component;
    return <Component routeState={coerceRouteState("chat", routeState)} />;
  }

  return null;
}
