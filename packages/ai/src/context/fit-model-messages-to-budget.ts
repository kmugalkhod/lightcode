import type { ModelMessage } from "ai";
import { MAX_TOOL_TEXT_OUTPUT_CHARS } from "../constants";
import { truncateText } from "../common/output-utils";
import { estimateTextTokens, safeStringify } from "./estimate";
import {
  collectConversationTurnRanges,
  computeRecentTurnStartIndex,
} from "./turns";

const MIN_TRUNCATION_CAP_CHARS = 256;
const modelMessageEstimateCache = new WeakMap<object, number>();

export function estimateModelMessageTokens(message: ModelMessage): number {
  const cached = modelMessageEstimateCache.get(message);
  if (cached !== undefined) {
    return cached;
  }
  const estimate = estimateTextTokens(safeStringify(message));
  modelMessageEstimateCache.set(message, estimate);
  return estimate;
}

export function estimateModelMessagesTokens(
  messages: readonly ModelMessage[],
): number {
  return messages.reduce(
    (total, message) => total + estimateModelMessageTokens(message),
    0,
  );
}

export interface FitModelMessagesToBudgetResult {
  messages: ModelMessage[];
  estimatedTokens: number;
  elidedToolOutputs: number;
  droppedMessages: number;
  truncatedTextParts: number;
  fitted: boolean;
  withinBudget: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function elideToolOutputs(message: ModelMessage): {
  message: ModelMessage;
  count: number;
} {
  if (!Array.isArray(message.content)) {
    return { message, count: 0 };
  }

  let count = 0;
  const content = (message.content as unknown[]).map((part: unknown) => {
    if (!isRecord(part) || part.type !== "tool-result" || !("output" in part)) {
      return part;
    }
    const output = Reflect.get(part, "output");
    if (
      isRecord(output) &&
      output.type === "text" &&
      typeof output.value === "string" &&
      output.value.startsWith("[Lightcode elided tool output")
    ) {
      return part;
    }

    count += 1;
    const originalChars = safeStringify(output).length;
    return {
      ...part,
      output: {
        type: "text",
        value:
          `[Lightcode elided tool output (${originalChars} chars) to fit the ` +
          "context budget. Re-run the tool if needed.]",
      },
    };
  });

  return count > 0
    ? { message: { ...message, content } as unknown as ModelMessage, count }
    : { message, count: 0 };
}

function truncateMessageText(
  message: ModelMessage,
  capChars: number,
): { message: ModelMessage; count: number } {
  if (typeof message.content === "string") {
    const result = truncateText(message.content, capChars);
    return result.truncated
      ? { message: { ...message, content: result.text } as ModelMessage, count: 1 }
      : { message, count: 0 };
  }

  let count = 0;
  const content = (message.content as unknown[]).map((part: unknown) => {
    if (!isRecord(part) || typeof part.text !== "string") {
      return part;
    }
    const result = truncateText(part.text, capChars);
    if (!result.truncated) {
      return part;
    }
    count += 1;
    return { ...part, text: result.text };
  });

  return count > 0
    ? { message: { ...message, content } as unknown as ModelMessage, count }
    : { message, count: 0 };
}

function latestUserIndex(messages: readonly ModelMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      return index;
    }
  }
  return -1;
}

/**
 * Per-step hard fit for AI SDK ModelMessages. It operates on the ephemeral
 * request only; the agent loop retains its complete in-memory transcript.
 */
export function fitModelMessagesToBudget(
  messages: readonly ModelMessage[],
  {
    inputBudgetTokens,
    preserveRecentTokens,
  }: {
    inputBudgetTokens: number;
    preserveRecentTokens: number;
  },
): FitModelMessagesToBudgetResult {
  const budget = Math.max(0, Math.floor(inputBudgetTokens));
  let working = [...messages];
  let elidedToolOutputs = 0;
  let droppedMessages = 0;
  let truncatedTextParts = 0;
  const fits = () => estimateModelMessagesTokens(working) <= budget;

  if (fits()) {
    return {
      messages: working,
      estimatedTokens: estimateModelMessagesTokens(working),
      elidedToolOutputs,
      droppedMessages,
      truncatedTextParts,
      fitted: false,
      withinBudget: true,
    };
  }

  const preserveFrom = computeRecentTurnStartIndex(
    working,
    preserveRecentTokens,
    estimateModelMessageTokens,
  );
  const preservedMessages = new Set(working.slice(preserveFrom));

  for (let index = 0; index < preserveFrom && !fits(); index += 1) {
    const result = elideToolOutputs(working[index]);
    working[index] = result.message;
    elidedToolOutputs += result.count;
  }

  while (!fits()) {
    const removable = collectConversationTurnRanges(
      working,
      estimateModelMessageTokens,
    ).find((turn) =>
      working
        .slice(turn.startIndex, turn.endIndex)
        .every((message) => !preservedMessages.has(message)),
    );
    if (!removable) {
      break;
    }
    const count = removable.endIndex - removable.startIndex;
    working.splice(removable.startIndex, count);
    droppedMessages += count;
  }

  if (!fits()) {
    working = working.map((message) => {
      const result = elideToolOutputs(message);
      elidedToolOutputs += result.count;
      return result.message;
    });

    // The preserved suffix is soft: under hard pressure, continue dropping
    // its oldest COMPLETE turns while protecting the newest turn. A false
    // result then unambiguously means the latest request itself is too large.
    while (!fits()) {
      const turns = collectConversationTurnRanges(
        working,
        estimateModelMessageTokens,
      );
      if (turns.length <= 1) {
        break;
      }
      const oldestTurn = turns[0];
      const count = oldestTurn.endIndex - oldestTurn.startIndex;
      working.splice(oldestTurn.startIndex, count);
      droppedMessages += count;
    }

    const protectedUserIndex = latestUserIndex(working);
    let capChars = MAX_TOOL_TEXT_OUTPUT_CHARS;
    while (!fits() && capChars >= MIN_TRUNCATION_CAP_CHARS) {
      working = working.map((message, index) => {
        if (index === protectedUserIndex) {
          return message;
        }
        const result = truncateMessageText(message, capChars);
        truncatedTextParts += result.count;
        return result.message;
      });
      capChars = Math.floor(capChars / 2);
    }

    if (!fits()) {
      const latestTurn = collectConversationTurnRanges(
        working,
        estimateModelMessageTokens,
      ).at(-1);
      if (latestTurn && latestTurn.startIndex > 0) {
        droppedMessages += latestTurn.startIndex;
        working.splice(0, latestTurn.startIndex);
      }
    }
  }

  return {
    messages: working,
    estimatedTokens: estimateModelMessagesTokens(working),
    elidedToolOutputs,
    droppedMessages,
    truncatedTextParts,
    fitted:
      elidedToolOutputs > 0 || droppedMessages > 0 || truncatedTextParts > 0,
    withinBudget: fits(),
  };
}
