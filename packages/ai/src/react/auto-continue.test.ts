import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { TodoItem } from "../todo-write/schema";
import {
  continueAfterLengthPrompt,
  decideAutoContinue,
  hasUnfinishedTodos,
  isDoomLoop,
  nudgeAfterPrematureStopPrompt,
  shouldTreatAsStalled,
  showsIntentToContinue,
} from "./auto-continue";

function assistantMessage({
  id = "a1",
  text = "Done.",
  finishReason = "stop",
  toolIntent,
}: {
  id?: string;
  text?: string;
  finishReason?: string;
  toolIntent?: string;
}): UIMessage {
  return {
    id,
    role: "assistant",
    metadata: {
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      finishReason,
      ...(toolIntent ? { toolIntent } : {}),
    },
    parts: [{ type: "text", text }],
  } as UIMessage;
}

const userMessage: UIMessage = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "build the feature" }],
} as UIMessage;

const noTodos: TodoItem[] = [];
const unfinishedTodos: TodoItem[] = [
  { content: "write tests", status: "in_progress", priority: "medium" },
];
const doneTodos: TodoItem[] = [
  { content: "write tests", status: "completed", priority: "medium" },
];

function decide(
  messages: UIMessage[],
  todos: TodoItem[] = noTodos,
  autoContinuesThisTurn = 0,
  limits = { enabled: true, maxAutoContinues: 50 },
) {
  return decideAutoContinue({ messages, todos, autoContinuesThisTurn, limits });
}

describe("decideAutoContinue", () => {
  test("continues when output was cut at the token limit", () => {
    const decision = decide([
      userMessage,
      assistantMessage({ finishReason: "length", text: "Half of the answer" }),
    ]);
    expect(decision.kind).toBe("continue-length");
    expect(decision.prompt).toBe(continueAfterLengthPrompt);
  });

  test("nudges when tool intent was detected but unparsed", () => {
    const decision = decide([
      userMessage,
      assistantMessage({ finishReason: "stop", toolIntent: "unparsed" }),
    ]);
    expect(decision.kind).toBe("nudge-stop");
    expect(decision.prompt).toBe(nudgeAfterPrematureStopPrompt);
  });

  test("nudges when todos are unfinished", () => {
    const decision = decide(
      [userMessage, assistantMessage({ finishReason: "stop", text: "Did part one." })],
      unfinishedTodos,
    );
    expect(decision.kind).toBe("nudge-stop");
  });

  test("nudges when trailing text announces more work", () => {
    const decision = decide([
      userMessage,
      assistantMessage({ finishReason: "stop", text: "I found the bug. Let me fix it now" }),
    ]);
    expect(decision.kind).toBe("nudge-stop");
  });

  test("does nothing on a clean finish", () => {
    const decision = decide(
      [userMessage, assistantMessage({ finishReason: "stop", text: "All done. Tests pass." })],
      doneTodos,
    );
    expect(decision.kind).toBe("none");
    expect(decision.guardTripped).toBeUndefined();
  });

  test("does nothing when disabled", () => {
    const decision = decide(
      [userMessage, assistantMessage({ finishReason: "length" })],
      noTodos,
      0,
      { enabled: false, maxAutoContinues: 50 },
    );
    expect(decision.kind).toBe("none");
  });

  test("trips the max-continues guard at the ceiling", () => {
    const decision = decide(
      [userMessage, assistantMessage({ finishReason: "length" })],
      noTodos,
      50,
    );
    expect(decision.kind).toBe("none");
    expect(decision.guardTripped).toBe("max-continues");
  });

  test("trips the doom-loop guard when responses repeat", () => {
    const repeated = "Reading the file now:";
    const messages = [
      userMessage,
      assistantMessage({ id: "a1", finishReason: "stop", text: repeated }),
      assistantMessage({ id: "a2", finishReason: "stop", text: repeated }),
      assistantMessage({ id: "a3", finishReason: "stop", text: repeated }),
    ];
    const decision = decide(messages, unfinishedTodos);
    expect(decision.kind).toBe("none");
    expect(decision.guardTripped).toBe("doom-loop");
  });

  test("does nothing when there is no assistant message", () => {
    expect(decide([userMessage]).kind).toBe("none");
  });
});

describe("helpers", () => {
  test("hasUnfinishedTodos", () => {
    expect(hasUnfinishedTodos(unfinishedTodos)).toBe(true);
    expect(hasUnfinishedTodos(doneTodos)).toBe(false);
    expect(hasUnfinishedTodos(noTodos)).toBe(false);
    expect(
      hasUnfinishedTodos([{ content: "x", status: "canceled", priority: "low" }]),
    ).toBe(false);
  });

  test("showsIntentToContinue", () => {
    expect(showsIntentToContinue("Here is the plan:")).toBe(true);
    expect(showsIntentToContinue("Next, I will update the schema")).toBe(true);
    expect(showsIntentToContinue("I'll now run the tests")).toBe(true);
    expect(showsIntentToContinue("The task is complete.")).toBe(false);
    expect(showsIntentToContinue("")).toBe(false);
  });

  test("shouldTreatAsStalled", () => {
    expect(
      shouldTreatAsStalled({ lastActivityAt: 0, now: 120_000, stallTimeoutMs: 120_000 }),
    ).toBe(true);
    expect(
      shouldTreatAsStalled({ lastActivityAt: 0, now: 119_999, stallTimeoutMs: 120_000 }),
    ).toBe(false);
    expect(
      shouldTreatAsStalled({ lastActivityAt: 0, now: 999_999, stallTimeoutMs: 0 }),
    ).toBe(false);
  });

  test("isDoomLoop requires a full window of identical responses", () => {
    const same = (id: string) =>
      assistantMessage({ id, text: "same response", finishReason: "stop" });
    expect(isDoomLoop([userMessage, same("a1"), same("a2")])).toBe(false);
    expect(isDoomLoop([userMessage, same("a1"), same("a2"), same("a3")])).toBe(true);
    expect(
      isDoomLoop([
        userMessage,
        same("a1"),
        same("a2"),
        assistantMessage({ id: "a3", text: "different", finishReason: "stop" }),
      ]),
    ).toBe(false);
  });
});
