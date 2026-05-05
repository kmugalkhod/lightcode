import { createGreeting, productName } from "@lightcode/shared";
import { useKeyboard, useRenderer } from "@opentui/react";

export function App() {
  const renderer = useRenderer();

  useKeyboard((key) => {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      renderer.destroy();
    }
  });

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      gap={1}
      padding={2}
      border
      borderStyle="rounded"
      borderColor="#7C3AED"
      title={` ${productName} `}
      titleAlignment="center"
    >
      <text fg="#A78BFA">
        <strong>{createGreeting("developer")}</strong>
      </text>
      <text fg="#E5E7EB">Bun workspace monorepo: Hono server + OpenTUI CLI</text>
      <text fg="#9CA3AF">Press Esc or Ctrl+C to exit</text>
    </box>
  );
}
