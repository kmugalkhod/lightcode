import type { LightcodeProvider } from "../config/lightcode-config";
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from "../context/config";

const CLAUDE_4_CONTEXT_WINDOW_TOKENS = 200_000;

const anthropicContextWindows: Record<string, number> = {
  "claude-haiku-4-5": CLAUDE_4_CONTEXT_WINDOW_TOKENS,
  "claude-sonnet-4-6": CLAUDE_4_CONTEXT_WINDOW_TOKENS,
  "claude-opus-4-7": CLAUDE_4_CONTEXT_WINDOW_TOKENS,
};

/**
 * Context window of a model in tokens. Falls back to a conservative default
 * for unknown models and arbitrary openai-compatible endpoints.
 */
export function getModelContextWindow(
  provider: LightcodeProvider,
  modelId: string,
): number {
  if (provider === "anthropic") {
    const known = anthropicContextWindows[modelId];
    if (known) {
      return known;
    }

    if (modelId.startsWith("claude-")) {
      return CLAUDE_4_CONTEXT_WINDOW_TOKENS;
    }
  }

  return DEFAULT_CONTEXT_WINDOW_TOKENS;
}
