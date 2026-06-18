import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { shouldUseFastChatPath } from "./chat-stream";

const userText = (text: string): UIMessage =>
  ({ role: "user", parts: [{ type: "text", text }] }) as UIMessage;

const assistantWithToolCall = (): UIMessage =>
  ({
    role: "assistant",
    parts: [
      { type: "text", text: "Editing the file." },
      {
        type: "tool-edit_file",
        toolCallId: "call_1",
        state: "output-available",
        input: {},
        output: {},
      },
    ],
  }) as unknown as UIMessage;

describe("shouldUseFastChatPath", () => {
  test("a single casual opening message takes the fast path", () => {
    expect(
      shouldUseFastChatPath({
        messages: [userText("hi")],
        mode: "build",
        allowedTools: undefined,
      }),
    ).toBe(true);
  });

  test("a session with prior tool activity always uses the agent path", () => {
    expect(
      shouldUseFastChatPath({
        messages: [
          userText("fix the bug"),
          assistantWithToolCall(),
          userText("continue"),
        ],
        mode: "build",
        allowedTools: undefined,
      }),
    ).toBe(false);
  });

  test("explicit allowedTools forces the agent path", () => {
    expect(
      shouldUseFastChatPath({
        messages: [userText("hi")],
        mode: "build",
        allowedTools: ["read_file"],
      }),
    ).toBe(false);
  });
});
