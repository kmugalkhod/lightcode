import { TextAttributes } from "@opentui/core";
import type { AnyRouteDefinition } from "../navigation/route-registry";
import { cliTheme, getOverlayRowColors } from "../ui/cli-theme";

interface SlashPageMenuProps {
  query: string;
  setQuery: (query: string) => void;
  selectedIndex: number;
  routes: AnyRouteDefinition[];
}

export function SlashPageMenu({
  query,
  setQuery,
  selectedIndex,
  routes,
}: SlashPageMenuProps) {
  return (
    <box
      width="100%"
      flexDirection="column"
      backgroundColor={cliTheme.overlay.surface}
      borderStyle="single"
      border={["left", "right"]}
      borderColor={cliTheme.overlay.border}
    >
      <box flexDirection="column" paddingX={1} paddingTop={1}>
        {routes.length === 0 && (
          <box paddingX={1}>
            <text fg={cliTheme.overlay.mutedText} attributes={TextAttributes.DIM}>No matching pages</text>
          </box>
        )}
        {routes.map((route, index) => {
          const selected = index === selectedIndex;
          const rowColors = getOverlayRowColors(selected);

          return (
            <box
              key={route.id}
              flexDirection="row"
              paddingX={1}
              backgroundColor={rowColors.backgroundColor}
            >
              <text
                fg={rowColors.primaryTextColor}
                attributes={TextAttributes.BOLD}
                width={22}
              >
                {route.path}
              </text>
              <text
                fg={rowColors.secondaryTextColor}
                attributes={selected ? TextAttributes.NONE : TextAttributes.DIM}
              >
                {route.description}
              </text>
            </box>
          );
        })}
      </box>

      <box paddingX={2} paddingTop={1} paddingBottom={1}>
        <input
          value={query}
          onChange={(value: string) => setQuery(value || "/")}
          placeholder="/"
          focused
          width="100%"
          backgroundColor={cliTheme.overlay.inputSurface}
          textColor={cliTheme.overlay.inputText}
        />
      </box>
    </box>
  );
}
