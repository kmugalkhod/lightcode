import { describe, expect, test } from "bun:test";
import { withAnthropicPromptCaching } from "./prompt-cache-middleware";
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";

function createCapturingModel() {
  const captured: { params?: LanguageModelV3CallOptions } = {};
  const model = {
    specificationVersion: "v3",
    provider: "anthropic",
    modelId: "claude-test",
    supportedUrls: {},
    doGenerate: async (params: LanguageModelV3CallOptions) => {
      captured.params = params;
      return {
        content: [],
        finishReason: "stop",
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error("not used");
    },
  } as unknown as LanguageModelV3;

  return { model, captured };
}

function cacheControlOf(message: unknown) {
  return (
    (message as { providerOptions?: { anthropic?: { cacheControl?: unknown } } })
      .providerOptions?.anthropic?.cacheControl ?? null
  );
}

describe("withAnthropicPromptCaching", () => {
  test("marks the system message and the final message as cache breakpoints", async () => {
    const { model, captured } = createCapturingModel();
    const wrapped = withAnthropicPromptCaching(model);

    await wrapped.doGenerate({
      prompt: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: [{ type: "text", text: "First question" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "First answer" }],
        },
        { role: "user", content: [{ type: "text", text: "Second question" }] },
      ],
    } as LanguageModelV3CallOptions);

    const prompt = captured.params?.prompt ?? [];
    expect(cacheControlOf(prompt[0])).toEqual({ type: "ephemeral" });
    expect(cacheControlOf(prompt[1])).toBeNull();
    expect(cacheControlOf(prompt[2])).toBeNull();
    expect(cacheControlOf(prompt[3])).toEqual({ type: "ephemeral" });
  });

  test("marks a lone system message only once", async () => {
    const { model, captured } = createCapturingModel();
    const wrapped = withAnthropicPromptCaching(model);

    await wrapped.doGenerate({
      prompt: [{ role: "system", content: "Solo system." }],
    } as LanguageModelV3CallOptions);

    const prompt = captured.params?.prompt ?? [];
    expect(prompt).toHaveLength(1);
    expect(cacheControlOf(prompt[0])).toEqual({ type: "ephemeral" });
  });
});
