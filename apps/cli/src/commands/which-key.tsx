import { TextAttributes } from "@opentui/core";
import { getLeaderBindings, type KeyBinding } from "./keymap";

export function WhichKey() {
  const bindings = getLeaderBindings();

  return (
    <box
      position="absolute"
      left="40%"
      top="40%"
      width="20%"
      flexDirection="column"
      backgroundColor="#1E1E1E"
      borderStyle="single"
      border={["top", "bottom", "left", "right"]}
      borderColor="#67E8F9"
    >
      <box paddingX={1} paddingY={1} borderStyle="single" border={["bottom"]}>
        <text fg="#67E8F9" attributes={TextAttributes.BOLD}>
          Leader Key Menu
        </text>
      </box>
      <box flexDirection="column" flexGrow={1} padding={1}>
        {bindings.map((binding) => (
          <box key={binding.sequence} flexDirection="row" justifyContent="space-between" paddingX={1}>
            <text fg="#FFFFFF">
              {binding.label}
            </text>
            <text fg="#8D8D8D" attributes={TextAttributes.DIM}>
              {binding.sequence}
            </text>
          </box>
        ))}
      </box>
      <box paddingX={1} paddingY={1} borderStyle="single" border={["top"]}>
        <text attributes={TextAttributes.DIM}>
          Press key or Esc to cancel
        </text>
      </box>
    </box>
  );
}