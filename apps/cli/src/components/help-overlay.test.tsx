import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import React from "react";
import {
  contextHintLine,
  contextKeyHints,
  contextKeyLabels,
  type KeyContext,
} from "../commands/context-keys";
import { HelpOverlay } from "./help-overlay";

describe("context key hints", () => {
  test("the hint line shows only primary keys, in order", () => {
    expect(contextHintLine("chat")).toBe("Enter send · Shift+Enter newline");
    expect(contextHintLine("ide")).toBe("Enter send · Tab explorer · F2 exit IDE");
    expect(contextHintLine("approval")).toBe("Enter approve · deny type to reject · or reply");
  });

  test("every context has at least one primary hint", () => {
    for (const context of Object.keys(contextKeyHints) as KeyContext[]) {
      expect(contextHintLine(context).length).toBeGreaterThan(0);
    }
  });
});

describe("HelpOverlay", () => {
  test("lists every context key from the shared registry", async () => {
    const setup = await testRender(<HelpOverlay />, { width: 260, height: 40 });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    for (const context of Object.keys(contextKeyHints) as KeyContext[]) {
      expect(frame).toContain(contextKeyLabels[context]);
      for (const hint of contextKeyHints[context]) {
        expect(frame).toContain(hint.label);
      }
    }
    // Aliases are listed once.
    expect(frame.split("Ctrl+/").length - 1).toBe(1);
  });
});
