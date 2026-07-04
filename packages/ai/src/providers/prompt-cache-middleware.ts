import {
  wrapLanguageModel,
  type LanguageModelMiddleware,
} from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";

type PromptMessage = {
  role: string;
  providerOptions?: Record<string, Record<string, unknown>>;
};

function withCacheBreakpoint<T extends PromptMessage>(message: T): T {
  return {
    ...message,
    providerOptions: {
      ...message.providerOptions,
      anthropic: {
        ...message.providerOptions?.anthropic,
        cacheControl: { type: "ephemeral" },
      },
    },
  };
}

/**
 * Direct-Anthropic prompt caching: the API only caches when the request marks
 * breakpoints, so annotate the two canonical ones — the system message (the
 * stable head, covering tools + instructions) and the final message (advances
 * every turn, so each request re-reads the previous turn's cached prefix and
 * writes one increment). Message-level cacheControl applies to the message's
 * last content part. Below Anthropic's cacheable minimum the marks are
 * ignored, so this is safe to apply unconditionally.
 */
const anthropicPromptCacheMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v3",
  transformParams: async ({ params }) => {
    const prompt = params.prompt;
    if (!Array.isArray(prompt) || prompt.length === 0) {
      return params;
    }

    const next = [...prompt];
    const systemIndex = next.findIndex((message) => message.role === "system");
    if (systemIndex >= 0) {
      next[systemIndex] = withCacheBreakpoint(next[systemIndex]);
    }

    const lastIndex = next.length - 1;
    if (lastIndex !== systemIndex) {
      next[lastIndex] = withCacheBreakpoint(next[lastIndex]);
    }

    return { ...params, prompt: next };
  },
};

export function withAnthropicPromptCaching(
  model: LanguageModelV3,
): LanguageModelV3 {
  return wrapLanguageModel({
    model,
    middleware: anthropicPromptCacheMiddleware,
  });
}
