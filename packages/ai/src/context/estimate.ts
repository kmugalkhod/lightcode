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
      /** Input tokens served from the provider's prompt cache, when reported. */
      cachedInputTokens: z.number().nonnegative().optional(),
    }),
    modelId: z.string().optional(),
    finishReason: languageModelFinishReasonSchema.optional(),
    /**
     * Server-measured context state for the assembled request. Authoritative
     * for the client's context meter — the client's own estimate is calibration
     * -blind when the summary anchor is lost.
     */
    context: z
      .object({
        inputTokens: z.number().nonnegative(),
        contextWindow: z.number().positive(),
        compactedMessages: z.number().nonnegative().optional(),
        systemTokens: z.number().nonnegative().optional(),
        toolTokens: z.number().nonnegative().optional(),
        messageTokens: z.number().nonnegative().optional(),
        mediaTokens: z.number().nonnegative().optional(),
        remainingTokens: z.number().nonnegative().optional(),
        compactedTokens: z.number().nonnegative().optional(),
      })
      .optional(),
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

// Per-object memo: one request estimates the same (immutable) message objects
// 4-6 times across buildProviderView, compaction re-views, and the fit clamp —
// and serializing every message is the dominant cost. WeakMap keys the exact
// object, so pruned/rewritten copies (new objects) correctly miss.
const messageTokenEstimateCache = new WeakMap<UIMessage, number>();

export function estimateMessageTokens(message: UIMessage): number {
  const cached = messageTokenEstimateCache.get(message);
  if (cached !== undefined) {
    return cached;
  }

  const estimate = estimateTextTokens(safeStringify(message));
  messageTokenEstimateCache.set(message, estimate);
  return estimate;
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
  // `usage` is cumulative billing usage across every tool-loop step. The
  // context meter and next-turn estimator need only the final provider
  // request's input, which the server records separately.
  if (typeof metadata.context?.inputTokens === "number") {
    return metadata.context.inputTokens;
  }

  const { totalTokens, inputTokens, outputTokens } = metadata.usage;
  if (typeof totalTokens === "number") {
    return totalTokens;
  }

  if (typeof inputTokens === "number") {
    return inputTokens + (outputTokens ?? 0);
  }

  return null;
}

function resolveMessageUsageTokens(
  metadata: MessageUsageMetadata,
  fallbackFixedInputTokens: number,
): number | null {
  if (metadata.context) {
    if (
      typeof metadata.context.messageTokens === "number" ||
      typeof metadata.context.mediaTokens === "number"
    ) {
      return (
        (metadata.context.messageTokens ?? 0) +
        (metadata.context.mediaTokens ?? 0)
      );
    }

    return Math.max(
      0,
      metadata.context.inputTokens -
        (metadata.context.systemTokens ?? fallbackFixedInputTokens) -
        (metadata.context.toolTokens ?? 0),
    );
  }

  const aggregate = resolveUsageTokens(metadata);
  return aggregate === null
    ? null
    : Math.max(0, aggregate - Math.max(0, fallbackFixedInputTokens));
}

/**
 * Estimates the provider-facing token footprint of a message list.
 *
 * When the most recent assistant message with usage metadata is found, its
 * final-step context count covers everything the provider saw up to that
 * point; only newer messages are estimated heuristically on top of it. Legacy
 * metadata without `context` falls back to the old aggregate usage fields.
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

/**
 * Estimates only the serialized message list, excluding the system/tool
 * overhead that modern server metadata reports separately. Request assembly
 * adds the current fixed overhead exactly once after this estimate.
 */
export function estimateProviderMessageTokens(
  messages: readonly UIMessage[],
  { fallbackFixedInputTokens = 0 }: { fallbackFixedInputTokens?: number } = {},
): ContextTokenEstimate {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const metadata = getMessageUsageMetadata(messages[index]);
    const usageTokens = metadata
      ? resolveMessageUsageTokens(metadata, fallbackFixedInputTokens)
      : null;
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
