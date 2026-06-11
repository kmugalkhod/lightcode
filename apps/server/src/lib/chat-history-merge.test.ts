import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { mergeFinishedMessagesIntoFullHistory } from "./chat-history-merge";

function textMessage(role: UIMessage["role"], id: string, text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

describe("mergeFinishedMessagesIntoFullHistory", () => {
  test("appends new assistant messages to the full history", () => {
    const fullMessages = [
      textMessage("user", "u0", "old request"),
      textMessage("assistant", "a0", "old answer"),
      textMessage("user", "u1", "new request"),
    ];
    // Provider view was compacted to 2 messages (summary + u1).
    const providerView = [
      textMessage("system", "lightcode-context-summary", "summary"),
      textMessage("user", "u1", "new request"),
    ];
    const responseMessage = textMessage("assistant", "a1", "new answer");

    const merged = mergeFinishedMessagesIntoFullHistory({
      fullMessages,
      providerMessageCount: providerView.length,
      finishedMessages: [...providerView, responseMessage],
      isContinuation: false,
      responseMessage,
    });

    expect(merged.map((message) => message.id)).toEqual([
      "u0",
      "a0",
      "u1",
      "a1",
    ]);
  });

  test("replaces the trailing assistant message on continuation", () => {
    const originalAssistant = textMessage("assistant", "a1", "partial");
    const fullMessages = [
      textMessage("user", "u0", "old request"),
      textMessage("user", "u1", "request"),
      originalAssistant,
    ];
    const providerView = [textMessage("user", "u1", "request"), originalAssistant];
    const extendedAssistant = textMessage("assistant", "a1", "partial + finished");

    const merged = mergeFinishedMessagesIntoFullHistory({
      fullMessages,
      providerMessageCount: providerView.length,
      finishedMessages: providerView.slice(0, -1).concat(extendedAssistant),
      isContinuation: true,
      responseMessage: extendedAssistant,
    });

    expect(merged.map((message) => message.id)).toEqual(["u0", "u1", "a1"]);
    expect(merged[2]).toBe(extendedAssistant);
  });

  test("appends the continuation response when history does not end with an assistant message", () => {
    const fullMessages = [textMessage("user", "u0", "request")];
    const responseMessage = textMessage("assistant", "a0", "answer");

    const merged = mergeFinishedMessagesIntoFullHistory({
      fullMessages,
      providerMessageCount: 1,
      finishedMessages: [fullMessages[0], responseMessage],
      isContinuation: true,
      responseMessage,
    });

    expect(merged.map((message) => message.id)).toEqual(["u0", "a0"]);
  });
});
