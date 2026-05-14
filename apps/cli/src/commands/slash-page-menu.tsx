import { TextAttributes } from "@opentui/core";
import type { AnyRouteDefinition } from "../navigation/route-registry";

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
      backgroundColor="#1F1F1F"
      borderStyle="single"
      border={["left", "right"]}
      borderColor="#777777"
    >
      <box flexDirection="column" paddingX={1} paddingTop={1}>
        {routes.length === 0 && (
          <box paddingX={1}>
            <text attributes={TextAttributes.DIM}>No matching pages</text>
          </box>
        )}
        {routes.map((route, index) => {
          const selected = index === selectedIndex;

          return (
            <box
              key={route.id}
              flexDirection="row"
              paddingX={1}
              backgroundColor={selected ? "#F5B07F" : "transparent"}
            >
              <text
                fg={selected ? "#000000" : "#FFFFFF"}
                attributes={TextAttributes.BOLD}
                width={22}
              >
                {route.path}
              </text>
              <text
                fg={selected ? "#000000" : "#8D8D8D"}
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
          backgroundColor="#1F1F1F"
          textColor="#FFFFFF"
        />
      </box>
    </box>
  );
}
