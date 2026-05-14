import { TextAttributes } from "@opentui/core";
import { getRoute } from "./route-registry";
import { getDefaultRouteState, type ViewId } from "./route-state";

interface RouteModalProps {
  viewId: ViewId;
}

export function RouteModal({ viewId }: RouteModalProps) {
  const route = getRoute(viewId);

  if (!route) {
    return null;
  }

  return (
    <box
      position="absolute"
      left="14%"
      top="18%"
      width="72%"
      height="58%"
      flexDirection="column"
      backgroundColor="#1F1F1F"
      borderStyle="single"
      border={["top", "bottom", "left", "right"]}
      borderColor="#3D3D3D"
    >
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingX={2}
        paddingY={1}
        borderStyle="single"
        border={["bottom"]}
      >
        <text attributes={TextAttributes.BOLD}>{route.label}</text>
        <text attributes={TextAttributes.DIM}>esc</text>
      </box>

      <box flexGrow={1} padding={2}>
        {route.id === "home" ? (
          <route.component routeState={getDefaultRouteState("home")} />
        ) : (
          <route.component routeState={getDefaultRouteState("chat")} />
        )}
      </box>
    </box>
  );
}
