import type { UIMessage } from "ai";
import { z } from "zod";

/**
 * Rough chars-per-token ratio used when no real usage data is available.
 * Real token counts come from provider usage metadata when present.
 */
export const ESTIMATED_CHARS_PER_TOKEN = 4;

/**
 * Usage metadata attached to assistant messages via the stream's
 * messageMetadata callback. Persisted inside the UIMessage payload, so the
 * estimator can calibrate against real provider token counts.
 */
export const languageModelFinishReasonSchema = z.enum([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
  "unknown",
]);
export type LanguageModelFinishReason = z.infer<typeof languageModelFinishReasonSchema>;

export const messageUsageMetadataSchema = z
  .object({
    usage: z.object({
      inputTokens: z.number().nonnegative().optional(),
      outputTokens: z.number().nonnegative().optional(),
      totalTokens: z.number().nonnegative().optional(),
    }),
    modelId: z.string().optional(),
    finishReason: languageModelFinishReasonSchema.optional(),
  })
  .loose();
export type MessageUsageMetadata = z.infer<typeof messageUsageMetadataSchema>;

export interface ContextTokenEstimate {
  tokens: number;
  /**
   * "usage_calibrated" when anchored on real provider usage from the most
   * recent assistant message that carries it; "heuristic" otherwise.
   */
  basis: "usage_calibrated" | "heuristic";
}

export function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN) + 1;
}

export function estimateMessageTokens(message: UIMessage): number {
  return estimateTextTokens(safeStringify(message));
}

export function getMessageUsageMetadata(
  message: UIMessage,
): MessageUsageMetadata | null {
  if (message.role !== "assistant" || message.metadata === undefined) {
    return null;
  }

  const parsed = messageUsageMetadataSchema.safeParse(message.metadata);
  return parsed.success ? parsed.data : null;
}

function resolveUsageTokens(metadata: MessageUsageMetadata): number | null {
  const { totalTokens, inputTokens, outputTokens } = metadata.usage;
  if (typeof totalTokens === "number") {
    return totalTokens;
  }

  if (typeof inputTokens === "number") {
    return inputTokens + (outputTokens ?? 0);
  }

  return null;
}

/**
 * Estimates the provider-facing token footprint of a message list.
 *
 * When the most recent assistant message with usage metadata is found, its
 * real token count covers everything the provider saw up to that point; only
 * newer messages are estimated heuristically on top of it.
 */
export function estimateContextTokens(
  messages: readonly UIMessage[],
): ContextTokenEstimate {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const metadata = getMessageUsageMetadata(messages[index]);
    const usageTokens = metadata ? resolveUsageTokens(metadata) : null;
    if (usageTokens !== null) {
      const tailTokens = messages
        .slice(index + 1)
        .reduce((total, message) => total + estimateMessageTokens(message), 0);

      return {
        tokens: Math.round(usageTokens + tailTokens),
        basis: "usage_calibrated",
      };
    }
  }

  return {
    tokens: messages.reduce(
      (total, message) => total + estimateMessageTokens(message),
      0,
    ),
    basis: "heuristic",
  };
}
