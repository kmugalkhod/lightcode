import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
  computePruneCutoffIndex,
  isElidedToolOutput,
  pruneToolOutputs,
} from "./tier1-prune";

function textMessage(role: UIMessage["role"], id: string, text: string): UIMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
  };
}

function toolPart(
  toolName: string,
  {
    toolCallId = `${toolName}-call`,
    state = "output-available",
    input = {} as unknown,
    output = undefined as unknown,
  } = {},
): UIMessage["parts"][number] {
  return {
    type: `tool-${toolName}`,
    toolCallId,
    state,
    input,
    output,
  } as unknown as UIMessage["parts"][number];
}

function assistantToolMessage(
  id: string,
  parts: UIMessage["parts"][number][],
): UIMessage {
  return { id, role: "assistant", parts };
}

function getToolOutput(message: UIMessage, partIndex = 0): unknown {
  return Reflect.get(message.parts[partIndex] as object, "output");
}

const bigOutput = { content: "x".repeat(5_000) };
const smallOutput = { content: "ok" };

describe("computePruneCutoffIndex", () => {
  test("returns 0 when everything fits in the recent window", () => {
    const messages = [
      textMessage("user", "u0", "hi"),
      textMessage("assistant", "a1", "hello"),
    ];

    expect(computePruneCutoffIndex(messages, 6, 1)).toBe(0);
  });

  test("snaps to a user-message boundary", () => {
    const messages = [
      textMessage("user", "u0", "one"),
      textMessage("assistant", "a1", "r1"),
      textMessage("user", "u2", "two"),
      textMessage("assistant", "a3", "r2"),
      textMessage("user", "u4", "three"),
      textMessage("assistant", "a5", "r3"),
    ];

    // candidate = 6 - 3 = 3 → snapped down to user index 2
    expect(computePruneCutoffIndex(messages, 3, 1)).toBe(2);
  });

  test("quantization advances the cutoff only every N user turns", () => {
    const makeConversation = (userTurns: number) => {
      const messages: UIMessage[] = [];
      for (let turn = 0; turn < userTurns; turn += 1) {
        messages.push(textMessage("user", `u${turn}`, `turn ${turn}`));
        messages.push(textMessage("assistant", `a${turn}`, `reply ${turn}`));
      }
      return messages;
    };

    // With quantize=4, the cutoff stays pinned at the user-turn ordinal 0 or 4.
    const cutoffs = [6, 7, 8, 9, 10].map((turns) =>
      computePruneCutoffIndex(makeConversation(turns), 2, 4),
    );

    // 6..8 user turns: snapped ordinals 5..7 quantize to 4 → index 8.
    expect(cutoffs[0]).toBe(8);
    expect(cutoffs[1]).toBe(8);
    expect(cutoffs[2]).toBe(8);
    // 9..10 user turns: snapped ordinals 8..9 quantize to 8 → index 16.
    expect(cutoffs[3]).toBe(16);
    expect(cutoffs[4]).toBe(16);
  });
});

describe("pruneToolOutputs", () => {
  test("elides large tool outputs outside the recent window only", () => {
    const messages = [
      textMessage("user", "u0", "start"),
      assistantToolMessage("a1", [
        toolPart("bash", { input: { command: "ls" }, output: bigOutput }),
      ]),
      textMessage("user", "u2", "next"),
      assistantToolMessage("a3", [
        toolPart("bash", {
          toolCallId: "bash-recent",
          input: { command: "pwd" },
          output: bigOutput,
        }),
      ]),
    ];

    const result = pruneToolOutputs(messages, {
      preserveRecentMessages: 2,
      quantizeUserTurns: 1,
    });

    expect(result.elidedToolOutputs).toBe(1);
    expect(result.savedChars).toBeGreaterThan(4_000);
    expect(isElidedToolOutput(getToolOutput(result.messages[1]))).toBe(true);
    // Recent window untouched.
    expect(getToolOutput(result.messages[3])).toEqual(bigOutput);
  });

  test("keeps small outputs and unresolved tool parts", () => {
    const messages = [
      textMessage("user", "u0", "start"),
      assistantToolMessage("a1", [
        toolPart("bash", { output: smallOutput }),
        toolPart("grep", { toolCallId: "grep-1", state: "input-available" }),
      ]),
      textMessage("user", "u2", "more"),
      textMessage("assistant", "a3", "done"),
      textMessage("user", "u4", "again"),
      textMessage("assistant", "a5", "done again"),
    ];

    const result = pruneToolOutputs(messages, {
      preserveRecentMessages: 2,
      quantizeUserTurns: 1,
    });

    expect(result.elidedToolOutputs).toBe(0);
    expect(getToolOutput(result.messages[1], 0)).toEqual(smallOutput);
  });

  test("dedupes earlier read_file outputs even when small", () => {
    const messages = [
      textMessage("user", "u0", "read it"),
      assistantToolMessage("a1", [
        toolPart("read_file", {
          toolCallId: "read-1",
          input: { path: "src/app.ts" },
          output: smallOutput,
        }),
      ]),
      textMessage("user", "u2", "read it again"),
      assistantToolMessage("a3", [
        toolPart("read_file", {
          toolCallId: "read-2",
          input: { path: "SRC\\APP.TS" },
          output: smallOutput,
        }),
      ]),
    ];

    const result = pruneToolOutputs(messages, {
      preserveRecentMessages: 2,
      quantizeUserTurns: 1,
      minOutputChars: 100_000,
    });

    expect(result.dedupedFileReads).toBe(1);
    expect(isElidedToolOutput(getToolOutput(result.messages[1]))).toBe(true);
    // The latest read (in the recent window) keeps its content.
    expect(getToolOutput(result.messages[3])).toEqual(smallOutput);
  });

  test("is idempotent on already-pruned input", () => {
    const messages = [
      textMessage("user", "u0", "start"),
      assistantToolMessage("a1", [toolPart("bash", { output: bigOutput })]),
      textMessage("user", "u2", "next"),
      textMessage("assistant", "a3", "done"),
    ];
    const options = { preserveRecentMessages: 2, quantizeUserTurns: 1 };

    const firstPass = pruneToolOutputs(messages, options);
    const secondPass = pruneToolOutputs(firstPass.messages, options);

    expect(firstPass.elidedToolOutputs).toBe(1);
    expect(secondPass.elidedToolOutputs).toBe(0);
    expect(secondPass.dedupedFileReads).toBe(0);
    expect(secondPass.savedChars).toBe(0);
    expect(secondPass.messages).toEqual(firstPass.messages);
  });
});
