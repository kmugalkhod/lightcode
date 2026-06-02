import { describe, expect, test } from "bun:test";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import {
  createParityMockLanguageModel,
  parityMockScenarios,
} from "./mock-provider";

async function readStream(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const reader = stream.getReader();
  const chunks: LanguageModelV3StreamPart[] = [];

  while (true) {
    const result = await reader.read();
    if (result.done) {
      return chunks;
    }

    chunks.push(result.value);
  }
}

const callOptions = {
  prompt: [],
} as LanguageModelV3CallOptions;

describe("parity mock provider", () => {
  test("streams deterministic text chunks", async () => {
    const model = createParityMockLanguageModel({
      scenario: parityMockScenarios.streamingText,
    });

    const result = await model.doStream(callOptions);
    const chunks = await readStream(result.stream);

    expect(model.doStreamCalls).toHaveLength(1);
    expect(result.request?.body).toEqual({ scenario: "streaming-text" });
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(chunks[2]).toMatchObject({
      type: "text-delta",
      delta: "Lightcode parity text.",
    });
  });

  test("generates and streams tool calls", async () => {
    const model = createParityMockLanguageModel({
      scenario: parityMockScenarios.readFileToolCall,
    });

    const generated = await model.doGenerate(callOptions);
    const streamed = await model.doStream(callOptions);
    const chunks = await readStream(streamed.stream);

    expect(generated.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "read-file-1",
        toolName: "read_file",
        input: '{"path":"README.md"}',
      },
    ]);
    expect(generated.finishReason.unified).toBe("tool-calls");
    expect(chunks.some((chunk) => chunk.type === "tool-call")).toBe(true);
  });

  test("streams tool input deltas before the final tool call", async () => {
    const model = createParityMockLanguageModel({
      scenario: parityMockScenarios.toolCallDeltas,
    });

    const result = await model.doStream(callOptions);
    const chunks = await readStream(result.stream);

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "stream-start",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-delta",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "finish",
    ]);
    expect(chunks[6]).toMatchObject({
      type: "tool-call",
      toolName: "grep",
      input: '{"pattern":"TODO","path":"src"}',
    });
  });

  test("throws configured provider failures", async () => {
    const model = createParityMockLanguageModel({
      scenario: parityMockScenarios.providerFailure,
    });

    await expect(model.doStream(callOptions)).rejects.toThrow(
      "Mock provider failure.",
    );
    await expect(model.doGenerate(callOptions)).rejects.toThrow(
      "Mock provider failure.",
    );
  });

  test("can terminate a stream with a recoverable disconnect", async () => {
    const model = createParityMockLanguageModel({
      scenario: parityMockScenarios.recoverableDisconnect,
    });

    const result = await model.doStream(callOptions);

    await expect(readStream(result.stream)).rejects.toThrow(
      "Mock recoverable disconnect.",
    );
  });
});
