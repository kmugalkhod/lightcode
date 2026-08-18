import { describe, expect, test } from "bun:test";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { xmlToolCallMiddleware } from "./xml-tool-call-middleware";
import { extractToolCalls, markerHoldbackLength } from "./xml-tool-call-parser";
import { healJsonSyntax, repairToolJson } from "./tool-call-json-repair";

const baseParams = {
  prompt: [],
  tools: [
    { type: "function", name: "read_file", inputSchema: { type: "object" } },
    { type: "function", name: "grep", inputSchema: { type: "object" } },
  ],
} as unknown as LanguageModelV3CallOptions;

function textStream(deltas: readonly string[]): ReadableStream<LanguageModelV3StreamPart> {
  const parts: LanguageModelV3StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    ...deltas.map((delta) => ({ type: "text-delta" as const, id: "t1", delta })),
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: undefined, reasoning: undefined },
      },
    },
  ];
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

async function runStream(
  deltas: readonly string[],
  params: LanguageModelV3CallOptions = baseParams,
): Promise<LanguageModelV3StreamPart[]> {
  const wrapped = await xmlToolCallMiddleware.wrapStream!({
    doStream: async () => ({ stream: textStream(deltas) }),
    doGenerate: async () => {
      throw new Error("not used");
    },
    params,
    model: {} as never,
  });
  const collected: LanguageModelV3StreamPart[] = [];
  const reader = wrapped.stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    collected.push(value);
  }
  return collected;
}

function textOf(parts: readonly LanguageModelV3StreamPart[]): string {
  return parts
    .filter((p): p is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> => p.type === "text-delta")
    .map((p) => p.delta)
    .join("");
}

function toolCallsOf(parts: readonly LanguageModelV3StreamPart[]) {
  return parts.filter(
    (p): p is Extract<LanguageModelV3StreamPart, { type: "tool-call" }> => p.type === "tool-call",
  );
}

function finishOf(parts: readonly LanguageModelV3StreamPart[]) {
  return parts.find(
    (p): p is Extract<LanguageModelV3StreamPart, { type: "finish" }> => p.type === "finish",
  );
}

describe("xmlToolCallMiddleware streaming", () => {
  test("parses <tool_call> JSON dialect and rewrites finishReason", async () => {
    const parts = await runStream([
      "Let me read the file.\n",
      '<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call>',
    ]);
    const calls = toolCallsOf(parts);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("read_file");
    expect(JSON.parse(calls[0].input)).toEqual({ path: "README.md" });
    expect(textOf(parts)).toContain("Let me read the file.");
    expect(textOf(parts)).not.toContain("<tool_call>");
    expect(finishOf(parts)?.finishReason.unified).toBe("tool-calls");
  });

  test("parses <function_call> dialect", async () => {
    const parts = await runStream([
      '<function_call>{"name":"grep","parameters":{"pattern":"TODO","path":"src"}}</function_call>',
    ]);
    const calls = toolCallsOf(parts);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("grep");
    expect(JSON.parse(calls[0].input)).toEqual({ pattern: "TODO", path: "src" });
  });

  test("parses <invoke> dialect with parameter tags", async () => {
    const parts = await runStream([
      '<invoke name="read_file"><parameter name="path">src/index.ts</parameter></invoke>',
    ]);
    const calls = toolCallsOf(parts);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("read_file");
    expect(JSON.parse(calls[0].input)).toEqual({ path: "src/index.ts" });
  });

  test("parses <function=name> dialect with JSON body", async () => {
    const parts = await runStream([
      '<function=grep>{"pattern": "lightcode", "path": "."}</function>',
    ]);
    const calls = toolCallsOf(parts);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("grep");
    expect(JSON.parse(calls[0].input)).toEqual({ pattern: "lightcode", path: "." });
  });

  test("parses DeepSeek unicode marker dialect with code fences", async () => {
    const parts = await runStream([
      "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>read_file\n",
      '```json\n{"path": "README.md"}\n```',
      "<｜tool▁call▁end｜><｜tool▁calls▁end｜>",
    ]);
    const calls = toolCallsOf(parts);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("read_file");
    expect(JSON.parse(calls[0].input)).toEqual({ path: "README.md" });
    expect(textOf(parts)).not.toContain("tool▁call");
  });

  test("repairs a truncated tool call (cut at token limit)", async () => {
    const parts = await runStream([
      '<tool_call>{"name":"read_file","arguments":{"path":"READ',
    ]);
    const calls = toolCallsOf(parts);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("read_file");
    expect(finishOf(parts)?.finishReason.unified).toBe("tool-calls");
  });

  test("flushes prose that mentions a marker without tool content (no strip, no flag)", async () => {
    const text = "I'll check that.\n<tool_call> is the tag MiniMax uses for tool calls.";
    const parts = await runStream([text]);
    expect(toolCallsOf(parts)).toHaveLength(0);
    expect(textOf(parts)).toBe(text);
    expect(finishOf(parts)?.providerMetadata?.lightcode?.toolIntent).toBeUndefined();
  });

  test("strips a plausibly truncated unrepairable call and flags metadata", async () => {
    const parts = await runStream(['On it.\n<tool_call>{"garbage": [1, 2,']);
    expect(toolCallsOf(parts)).toHaveLength(0);
    expect(textOf(parts)).not.toContain("<tool_call>");
    expect(textOf(parts)).toContain("On it.");
    const finish = finishOf(parts);
    expect(finish?.providerMetadata?.lightcode?.toolIntent).toBe("unparsed");
  });

  test("parses a streamed bare trailing JSON call", async () => {
    const parts = await runStream([
      '{"na',
      'me": "read_file", "arguments": {"path": "a.ts"}}',
    ]);
    const calls = toolCallsOf(parts);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("read_file");
    expect(JSON.parse(calls[0]?.input ?? "{}")).toEqual({ path: "a.ts" });
    expect(textOf(parts)).toBe("");
    expect(finishOf(parts)?.finishReason.unified).toBe("tool-calls");
  });

  test("streams bare JSON with an unknown tool name as ordinary text", async () => {
    const text = '{"name": "lightcode", "version": "1.0.0"}';
    const parts = await runStream([text]);
    expect(toolCallsOf(parts)).toHaveLength(0);
    expect(textOf(parts)).toBe(text);
    expect(finishOf(parts)?.providerMetadata?.lightcode?.toolIntent).toBeUndefined();
  });

  test("package.json prose streams incrementally without latching", async () => {
    let releaseRest: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRest = resolve;
    });
    const upstream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "t1" });
        controller.enqueue({
          type: "text-delta",
          id: "t1",
          delta: 'The dist package.json needs {"name": "lightcode", "bin": {"lightcode": "./cli.js"}} and more. ',
        });
        await gate;
        controller.enqueue({ type: "text-delta", id: "t1", delta: "Then run npm pack." });
        controller.enqueue({ type: "text-end", id: "t1" });
        controller.enqueue({
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: undefined, reasoning: undefined },
          },
        });
        controller.close();
      },
    });

    const wrapped = await xmlToolCallMiddleware.wrapStream!({
      doStream: async () => ({ stream: upstream }),
      doGenerate: async () => {
        throw new Error("not used");
      },
      params: baseParams,
      model: {} as never,
    });

    const reader = wrapped.stream.getReader();
    const collected: LanguageModelV3StreamPart[] = [];
    for (;;) {
      const { value } = await reader.read();
      if (!value) break;
      collected.push(value);
      if (value.type === "text-delta") break;
    }
    // The first delta must arrive BEFORE the stream finishes — no latch.
    const firstDelta = collected.find((p) => p.type === "text-delta");
    expect(firstDelta).toBeDefined();
    expect((firstDelta as { delta: string }).delta).toContain("package.json needs");

    releaseRest?.();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      collected.push(value);
    }
    expect(toolCallsOf(collected)).toHaveLength(0);
    expect(textOf(collected)).toContain('{"name": "lightcode"');
    expect(textOf(collected)).toContain("Then run npm pack.");
  });

  test("markers inside code fences stream through verbatim", async () => {
    const text =
      'Here is the middleware doc:\n```ts\n// <tool_call>{"name":"read_file","parameters":{...}}</tool_call>\n```\nThat is how it works.';
    const parts = await runStream([text]);
    expect(toolCallsOf(parts)).toHaveLength(0);
    expect(textOf(parts)).toBe(text);
    expect(finishOf(parts)?.providerMetadata?.lightcode?.toolIntent).toBeUndefined();
  });

  test("text after a completed tool call keeps streaming", async () => {
    const parts = await runStream([
      "Reading it now.\n",
      '<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>',
      "\nDone with the call.",
    ]);
    const calls = toolCallsOf(parts);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("read_file");
    expect(textOf(parts)).toContain("Reading it now.");
    expect(textOf(parts)).toContain("Done with the call.");
    expect(finishOf(parts)?.finishReason.unified).toBe("tool-calls");
  });

  test("plain text streams through incrementally", async () => {
    let releaseSecondDelta: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseSecondDelta = resolve;
    });

    const upstream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "t1" });
        controller.enqueue({ type: "text-delta", id: "t1", delta: "Hello world. " });
        await gate;
        controller.enqueue({ type: "text-delta", id: "t1", delta: "Goodbye." });
        controller.enqueue({ type: "text-end", id: "t1" });
        controller.enqueue({
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: undefined, reasoning: undefined },
          },
        });
        controller.close();
      },
    });

    const wrapped = await xmlToolCallMiddleware.wrapStream!({
      doStream: async () => ({ stream: upstream }),
      doGenerate: async () => {
        throw new Error("not used");
      },
      params: baseParams,
      model: {} as never,
    });

    const reader = wrapped.stream.getReader();
    const firstParts: LanguageModelV3StreamPart[] = [];
    // Read until the first text-delta arrives — before the upstream finishes.
    for (;;) {
      const { value } = await reader.read();
      if (!value) break;
      firstParts.push(value);
      if (value.type === "text-delta") break;
    }
    const firstDelta = firstParts.find((p) => p.type === "text-delta");
    expect(firstDelta).toBeDefined();
    expect((firstDelta as { delta: string }).delta).toContain("Hello world.");

    releaseSecondDelta?.();
    const rest: LanguageModelV3StreamPart[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest.push(value);
    }
    expect(textOf([...firstParts, ...rest])).toBe("Hello world. Goodbye.");
  });

  test("marker split across deltas is still detected", async () => {
    const parts = await runStream([
      "Checking now <tool",
      '_call>{"name":"grep","arguments":{"pattern":"x"}}</tool_call>',
    ]);
    const calls = toolCallsOf(parts);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("grep");
    expect(textOf(parts).trim()).toBe("Checking now");
  });
});

describe("xmlToolCallMiddleware wrapGenerate", () => {
  test("converts XML tool calls in generate results", async () => {
    const result = await xmlToolCallMiddleware.wrapGenerate!({
      doGenerate: async () =>
        ({
          content: [
            {
              type: "text",
              text: 'On it.\n<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>',
            },
          ],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: undefined, reasoning: undefined },
          },
          warnings: [],
        }) as never,
      doStream: async () => {
        throw new Error("not used");
      },
      params: baseParams,
      model: {} as never,
    });

    const toolCalls = result.content.filter((p) => p.type === "tool-call");
    expect(toolCalls).toHaveLength(1);
    expect(result.finishReason.unified).toBe("tool-calls");
    const text = result.content.find((p) => p.type === "text");
    expect((text as { text: string } | undefined)?.text).toBe("On it.");
  });
});

describe("extractToolCalls", () => {
  test("extracts multiple calls and preserves surrounding text", async () => {
    const { calls, cleanText } = await extractToolCalls(
      'First:\n<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>\nthen\n<tool_call>{"name":"grep","arguments":{"pattern":"b"}}</tool_call>',
    );
    expect(calls.map((c) => c.toolName)).toEqual(["read_file", "grep"]);
    expect(cleanText).toContain("First:");
    expect(cleanText).toContain("then");
  });
});

describe("markerHoldbackLength", () => {
  test("holds back partial markers only", () => {
    expect(markerHoldbackLength("hello <tool_ca")).toBe(8);
    expect(markerHoldbackLength("hello world")).toBe(0);
    expect(markerHoldbackLength("end with <")).toBe(1);
  });
});

describe("repairToolJson", () => {
  test("parses valid JSON directly", async () => {
    expect(await repairToolJson('{"a": 1}')).toEqual({ a: 1 });
  });

  test("repairs truncated JSON", async () => {
    const result = (await repairToolJson('{"name": "read_file", "arguments": {"path": "REA')) as Record<
      string,
      unknown
    >;
    expect(result.name).toBe("read_file");
  });

  test("repairs single quotes and unquoted keys", async () => {
    expect(await repairToolJson("{name: 'read_file', path: 'a.ts'}")).toEqual({
      name: "read_file",
      path: "a.ts",
    });
  });

  test("repairs Python literals and trailing commas", async () => {
    expect(await repairToolJson('{"flag": True, "other": None, "x": 1,}')).toEqual({
      flag: true,
      other: null,
      x: 1,
    });
  });

  test("returns null for hopeless input", async () => {
    expect(await repairToolJson("complete garbage here")).toBeNull();
  });

  test("healJsonSyntax escapes raw newlines inside strings", () => {
    expect(healJsonSyntax('{"a": "line1\nline2"}')).toBe('{"a": "line1\\nline2"}');
  });
});
