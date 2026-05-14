import { getRoute } from "./route-registry";
import type { RouteState, ViewId } from "../state/app-state";

interface RouterProps {
  currentView: ViewId;
  routeState: RouteState;
}

export function Router({ currentView, routeState }: RouterProps) {
  const route = getRoute(currentView);

  if (!route) {
    return null;
  }

  const Component = route.component;
  return <Component routeState={routeState} />;
}
