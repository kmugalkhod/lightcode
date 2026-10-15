import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import React from "react";
import { ChatShell } from "./chat-shell";
import { NarrowPanelDrawer } from "./ide-layout";

async function frame(node: React.ReactNode, width: number, height: number) {
  const setup = await testRender(<>{node}</>, { width, height });
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("ChatShell header", () => {
  test("puts title, project and branch on the first row", async () => {
    const output = await frame(
      <ChatShell
        title="Fix the picker"
        context={["lightcode", "⎇ ui-improvement"]}
        hasMessages={false}
        messageCount={3}
        inputArea={<text>input</text>}
      />,
      80,
      12,
    );
    const [firstRow] = output.split("\n");
    if (Bun.env.LIGHTCODE_PRINT_FRAMES) console.log(output);
    expect(firstRow).toContain("Fix the picker · lightcode · ⎇ ui-improvement");
    expect(firstRow).toContain("3 messages");
    // The transcript border starts directly below the header row.
    expect(output.split("\n")[1]?.trim().startsWith("┌") ||
      output.split("\n")[1]?.trim().startsWith("╭")).toBe(true);
  });

  test("clips a long title instead of wrapping into the transcript", async () => {
    const output = await frame(
      <ChatShell
        title={"A very long session title ".repeat(6)}
        context={["project"]}
        hasMessages={false}
        messageCount={1}
        inputArea={<text>input</text>}
      />,
      60,
      10,
    );
    expect(output.split("\n")[0]).toContain("1 message");
  });
});

describe("NarrowPanelDrawer", () => {
  test("stacks explorer over the viewer with a one-line hint", async () => {
    const output = await frame(
      <NarrowPanelDrawer
        explorer={<text>EXPLORER-PANE</text>}
        editor={<text>EDITOR-PANE</text>}
        hint="↑/↓ · Enter open · Esc close"
        onClose={() => {}}
      />,
      80,
      20,
    );
    if (Bun.env.LIGHTCODE_PRINT_FRAMES) console.log(output);
    const rows = output.split("\n");
    const explorerRow = rows.findIndex((row) => row.includes("EXPLORER-PANE"));
    const editorRow = rows.findIndex((row) => row.includes("EDITOR-PANE"));
    expect(explorerRow).toBeGreaterThan(0);
    expect(editorRow).toBeGreaterThan(explorerRow);
    expect(output).toContain("Esc close");
  });
});
