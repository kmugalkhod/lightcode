import { describe, expect, test } from "bun:test";
import { isToolUIPart, type UIMessage } from "ai";
import {
  hasDanglingToolParts,
  normalizeProviderMessages,
  resolveDanglingToolParts,
} from "./normalize-provider-messages";

function user(text = "do it"): UIMessage {
  return { id: "u1", role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

function assistantTool(state: string, extra: Record<string, unknown> = {}): UIMessage {
  return {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "text", text: "calling", state: "done" },
      {
        type: "tool-read_file",
        toolCallId: "call-1",
        state,
        input: { path: "x.ts" },
        ...extra,
      },
    ],
  } as unknown as UIMessage;
}

function toolStates(message: UIMessage): string[] {
  return message.parts
    .filter((part) => isToolUIPart(part))
    .map((part) => String(Reflect.get(part, "state")));
}

describe("normalizeProviderMessages", () => {
  test("synthesizes an error result for a dangling tool call", () => {
    const out = normalizeProviderMessages([user(), assistantTool("input-available")]);

    expect(hasDanglingToolParts(out)).toBe(false);
    expect(toolStates(out[1])).toEqual(["output-error"]);
    const [toolPart] = out[1].parts.filter((part) => isToolUIPart(part));
    expect(String(Reflect.get(toolPart, "errorText"))).toContain("interrupted");
  });

  test("leaves resolved tool calls untouched and is count-preserving", () => {
    const input = [
      user(),
      assistantTool("output-available", { output: { content: "ok" } }),
    ];
    const out = normalizeProviderMessages(input);

    expect(out).toHaveLength(input.length);
    expect(out[1]).toBe(input[1]); // unchanged reference when nothing to repair
    expect(hasDanglingToolParts(out)).toBe(false);
  });

  test("never drops or adds messages (merge count stays valid)", () => {
    const input = [
      user(),
      assistantTool("input-streaming"),
      user("again"),
      assistantTool("input-available"),
    ];
    const out = resolveDanglingToolParts(input);

    expect(out).toHaveLength(input.length);
    expect(hasDanglingToolParts(out)).toBe(false);
  });
});
