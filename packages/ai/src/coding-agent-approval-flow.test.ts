import { describe, expect, test } from "bun:test";
import type {
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import {
  createAgentUIStreamResponse,
  safeValidateUIMessages,
  simulateReadableStream,
  stepCountIs,
  ToolLoopAgent,
  tool,
  type UIMessage,
} from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";

/**
 * Spike/regression coverage for the ai@6 approval flow the server-side tool
 * loop (plan Phase 1) depends on:
 *
 * 1. a tool with `execute` runs inside ONE request and the loop continues;
 * 2. `needsApproval: true` emits a tool-approval-request and defers execution;
 * 3. a follow-up request whose last assistant message carries the
 *    `approval-responded` part executes the tool and continues the loop.
 */

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function finish(
  unified: LanguageModelV3FinishReason["unified"],
): LanguageModelV3StreamPart {
  return { type: "finish", finishReason: { unified, raw: unified }, usage };
}

function textChunks(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    finish("stop"),
  ];
}

function toolCallChunks(
  toolName: string,
  toolCallId: string,
  input: unknown,
): LanguageModelV3StreamPart[] {
  return [
    {
      type: "tool-call",
      toolCallId,
      toolName,
      input: JSON.stringify(input),
    },
    finish("tool-calls"),
  ];
}

/** Mock model that serves a different scripted stream per call. */
function createSequentialMockModel(
  calls: LanguageModelV3StreamPart[][],
): MockLanguageModelV3 {
  let callIndex = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const parts = calls[Math.min(callIndex, calls.length - 1)];
      callIndex += 1;
      return {
        stream: simulateReadableStream({
          chunks: [{ type: "stream-start", warnings: [] }, ...parts],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

function createEchoAgent({
  model,
  needsApproval,
  onExecute,
}: {
  model: MockLanguageModelV3;
  needsApproval: boolean;
  onExecute: (input: { value: string }) => void;
}) {
  return new ToolLoopAgent({
    model,
    stopWhen: stepCountIs(5),
    tools: {
      echo: tool({
        description: "Echo a value.",
        inputSchema: z.object({ value: z.string() }),
        needsApproval,
        execute: async (input: { value: string }) => {
          onExecute(input);
          return { echoed: input.value };
        },
      }),
    },
  });
}

const userMessage: UIMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "echo hello" }],
};

async function streamToText(response: Response): Promise<string> {
  return await response.text();
}

describe("ai@6 approval flow (server-side loop spike)", () => {
  test("tool with execute runs in a single request and the loop continues", async () => {
    const executed: Array<{ value: string }> = [];
    const agent = createEchoAgent({
      model: createSequentialMockModel([
        toolCallChunks("echo", "echo-1", { value: "hello" }),
        textChunks("done after tool"),
      ]),
      needsApproval: false,
      onExecute: (input) => executed.push(input),
    });

    const body = await streamToText(
      await createAgentUIStreamResponse({
        agent,
        uiMessages: [userMessage],
      }),
    );

    expect(executed).toEqual([{ value: "hello" }]);
    // Tool result streamed to the UI, then the follow-up model turn.
    expect(body).toContain("tool-output-available");
    expect(body).toContain("done after tool");
  });

  test("needsApproval emits approval request and defers execution", async () => {
    const executed: Array<{ value: string }> = [];
    const agent = createEchoAgent({
      model: createSequentialMockModel([
        toolCallChunks("echo", "echo-1", { value: "hello" }),
        textChunks("should not be reached"),
      ]),
      needsApproval: true,
      onExecute: (input) => executed.push(input),
    });

    const body = await streamToText(
      await createAgentUIStreamResponse({
        agent,
        uiMessages: [userMessage],
      }),
    );

    expect(executed).toEqual([]);
    expect(body).toContain("tool-approval-request");
    expect(body).not.toContain("should not be reached");
  });

  test("follow-up request with approval-responded executes and continues", async () => {
    const executed: Array<{ value: string }> = [];
    const agent = createEchoAgent({
      model: createSequentialMockModel([textChunks("done after approval")]),
      needsApproval: true,
      onExecute: (input) => executed.push(input),
    });

    const approvedAssistantMessage = {
      id: "assistant-1",
      role: "assistant" as const,
      parts: [
        {
          type: "tool-echo" as const,
          toolCallId: "echo-1",
          state: "approval-responded" as const,
          input: { value: "hello" },
          approval: { id: "approval-1", approved: true },
        },
      ],
    } as unknown as UIMessage;

    const body = await streamToText(
      await createAgentUIStreamResponse({
        agent,
        uiMessages: [userMessage, approvedAssistantMessage],
      }),
    );

    expect(executed).toEqual([{ value: "hello" }]);
    expect(body).toContain("tool-output-available");
    expect(body).toContain("done after approval");
  });

  test("safeValidateUIMessages accepts approval part states", async () => {
    // The server validates every incoming payload with safeValidateUIMessages
    // before streaming; approval states must round-trip through it.
    const result = await safeValidateUIMessages({
      messages: [
        userMessage,
        {
          id: "assistant-1",
          role: "assistant",
          parts: [
            {
              type: "tool-echo",
              toolCallId: "echo-1",
              state: "approval-responded",
              input: { value: "hello" },
              approval: { id: "approval-1", approved: true },
            },
          ],
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  test("denied approval yields output-denied without executing", async () => {
    const executed: Array<{ value: string }> = [];
    const agent = createEchoAgent({
      model: createSequentialMockModel([textChunks("acknowledged denial")]),
      needsApproval: true,
      onExecute: (input) => executed.push(input),
    });

    const deniedAssistantMessage = {
      id: "assistant-1",
      role: "assistant" as const,
      parts: [
        {
          type: "tool-echo" as const,
          toolCallId: "echo-1",
          state: "approval-responded" as const,
          input: { value: "hello" },
          approval: { id: "approval-1", approved: false, reason: "not now" },
        },
      ],
    } as unknown as UIMessage;

    const body = await streamToText(
      await createAgentUIStreamResponse({
        agent,
        uiMessages: [userMessage, deniedAssistantMessage],
      }),
    );

    expect(executed).toEqual([]);
    expect(body).toContain("acknowledged denial");
  });
});
