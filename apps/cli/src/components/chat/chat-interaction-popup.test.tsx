import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { createMockKeys } from "@opentui/core/testing";
import React from "react";
import {
  ChatInteractionPopup,
  type ChatInteractionSubmitPayload,
} from "./chat-interaction-popup";

const flush = async (setup: { renderOnce: () => Promise<void> }) => {
  // Key handlers set React state; give React a tick to commit before the
  // next key so each press sees the updated UI (mirrors live pacing). The
  // wait also covers the parser's lone-ESC disambiguation delay.
  await new Promise((resolve) => setTimeout(resolve, 30));
  await setup.renderOnce();
};

async function renderPopup(
  props: Partial<React.ComponentProps<typeof ChatInteractionPopup>> = {},
) {
  const submissions: ChatInteractionSubmitPayload[] = [];
  const setup = await testRender(
    <ChatInteractionPopup
      title="Question"
      question="Which color do you prefer?"
      options={[
        { value: "red", label: "Red", description: "Warm" },
        { value: "blue", label: "Blue", description: "Cool" },
      ]}
      onSubmit={(payload) => submissions.push(payload)}
      {...props}
    />,
    { width: 80, height: 24 },
  );
  const keys = createMockKeys(setup.renderer);
  await flush(setup);
  return { setup, keys, submissions };
}

describe("ChatInteractionPopup", () => {
  test("a single Enter submits the selected option", async () => {
    const { setup, keys, submissions } = await renderPopup();

    keys.pressEnter();
    await flush(setup);

    expect(submissions).toEqual([
      {
        answer: "Red",
        selectedOption: "Red",
        selectedValue: "red",
        source: "option",
      },
    ]);
    setup.renderer.destroy();
  });

  test("typed custom answer submits on the first Enter", async () => {
    const { setup, keys, submissions } = await renderPopup({
      allowCustomResponse: true,
    });

    // Move to the "Type your own answer" row (below the two options).
    keys.pressArrow("down");
    await flush(setup);
    keys.pressArrow("down");
    await flush(setup);
    await keys.typeText("Crimson");
    await flush(setup);
    keys.pressEnter();
    await flush(setup);

    expect(submissions).toEqual([
      {
        answer: "Crimson",
        selectedOption: undefined,
        selectedValue: undefined,
        source: "custom",
      },
    ]);
    setup.renderer.destroy();
  });

  test("question without options goes straight to the input", async () => {
    const { setup, keys, submissions } = await renderPopup({
      options: [],
      allowCustomResponse: true,
    });

    // No option list is rendered — the input is immediately focused.
    expect(setup.captureCharFrame()).not.toContain("Type your own answer");

    await keys.typeText("Red");
    await flush(setup);
    keys.pressEnter();
    await flush(setup);

    expect(submissions).toEqual([
      {
        answer: "Red",
        selectedOption: undefined,
        selectedValue: undefined,
        source: "custom",
      },
    ]);
    setup.renderer.destroy();
  });

  test("number keys pick and submit an option directly", async () => {
    const { setup, keys, submissions } = await renderPopup();

    keys.pressKey("2");
    await flush(setup);

    expect(submissions).toEqual([
      {
        answer: "Blue",
        selectedOption: "Blue",
        selectedValue: "blue",
        source: "option",
      },
    ]);
    setup.renderer.destroy();
  });

  test("empty custom answer shows validation instead of submitting", async () => {
    const { setup, keys, submissions } = await renderPopup({
      options: [],
      allowCustomResponse: true,
    });

    keys.pressEnter();
    await flush(setup);

    expect(submissions).toEqual([]);
    expect(setup.captureCharFrame()).toContain("Type an answer first");
    setup.renderer.destroy();
  });

  test("option requiring a note submits the typed note", async () => {
    const { setup, keys, submissions } = await renderPopup({
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
      allowCustomResponse: true,
      requireCustomResponseForValues: ["no"],
    });

    keys.pressArrow("down");
    await flush(setup);
    await keys.typeText("needs work");
    await flush(setup);
    keys.pressEnter();
    await flush(setup);

    expect(submissions).toEqual([
      {
        answer: "needs work",
        selectedOption: "No",
        selectedValue: "no",
        source: "custom",
      },
    ]);
    setup.renderer.destroy();
  });

  test("Escape cancels when onCancel is provided", async () => {
    let cancelled = false;
    const { setup, keys, submissions } = await renderPopup({
      onCancel: () => {
        cancelled = true;
      },
    });

    keys.pressEscape();
    await flush(setup);

    expect(cancelled).toBe(true);
    expect(submissions).toEqual([]);
    setup.renderer.destroy();
  });
});
