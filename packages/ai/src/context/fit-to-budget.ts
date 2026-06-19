import type { UIMessage } from "ai";
import { MAX_TOOL_TEXT_OUTPUT_CHARS } from "../constants";
import { truncateText } from "../common/output-utils";
import { estimateMessageTokens, safeStringify } from "./estimate";
import { contextSummaryMessageId } from "./heuristic-summary";
import { getToolNameFromPart, isRecord, type UIMessagePart } from "./message-parts";
import {
  isElidedToolOutput,
  type ToolOutputElisionStub,
} from "./tier1-prune";

/**
 * Smallest per-part char cap the last-resort truncation will shrink to before
 * giving up. Keeps termination bounded while still letting a pathological
 * single huge message be cut down to almost nothing.
 */
const MIN_TRUNCATION_CAP_CHARS = 256;

export interface FitToBudgetOptions {
  /** Hard ceiling for the assembled provider view, in estimated input tokens. */
  inputBudgetTokens: number;
  /** Recent messages kept intact until the last-resort truncation pass. */
  preserveRecentMessages: number;
}

export interface FitToBudgetResult {
  messages: UIMessage[];
  /** Tool outputs replaced with an elision stub. */
  elidedToolOutputs: number;
  /** Whole messages removed from the view (oldest first). */
  droppedMessages: number;
  /** Text parts hard-truncated as a last resort. */
  truncatedTextParts: number;
  /** Structural token estimate of the returned view. */
  estimatedTokens: number;
  /** True when any reduction was applied. */
  fitted: boolean;
  /** True when the returned view is within the budget. */
  withinBudget: boolean;
}

/**
 * Structural token estimate: the pure sum of per-message heuristic estimates.
 *
 * Deliberately NOT usage-calibrated. A usage-calibrated estimate anchors on the
 * provider's reported token count for the last assistant turn, so it does not
 * shrink when we drop or elide *older* messages — making it useless to drive a
 * clamp. The structural sum is monotonic in the actual payload, so every
 * reduction step provably lowers it and the loop converges.
 */
export function estimateStructuralTokens(messages: readonly UIMessage[]): number {
  return messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0,
  );
}

function getPartState(part: UIMessagePart): string | null {
  const state = isRecord(part) ? Reflect.get(part, "state") : undefined;
  return typeof state === "string" ? state : null;
}

function elideOutput(
  part: UIMessagePart,
  originalChars: number,
): UIMessagePart {
  const stub: ToolOutputElisionStub = {
    lightcodeElided: true,
    note: "Tool output elided to fit the model's context budget. Re-run the tool if this output is needed again.",
    originalChars,
  };
  // Tool parts are structurally open at runtime; swapping `output` keeps the
  // part valid for providers while shedding its payload.
  return { ...(part as Record<string, unknown>), output: stub } as UIMessagePart;
}

/** Replaces every non-elided tool output in a message with an elision stub. */
function elideToolOutputsInMessage(message: UIMessage): {
  message: UIMessage;
  elided: number;
} {
  let elided = 0;
  const parts = message.parts.map((part) => {
    if (!getToolNameFromPart(part) || getPartState(part) !== "output-available") {
      return part;
    }

    const output = isRecord(part) ? Reflect.get(part, "output") : undefined;
    if (output === undefined || isElidedToolOutput(output)) {
      return part;
    }

    elided += 1;
    return elideOutput(part, safeStringify(output).length);
  });

  return elided > 0 ? { message: { ...message, parts }, elided } : { message, elided: 0 };
}

/** Hard-truncates oversized text parts in a message to `capChars`. */
function truncateTextPartsInMessage(
  message: UIMessage,
  capChars: number,
): { message: UIMessage; truncated: number } {
  let truncated = 0;
  const parts = message.parts.map((part) => {
    if (!isRecord(part)) {
      return part;
    }

    const text = Reflect.get(part, "text");
    if (typeof text !== "string" || text.length <= capChars) {
      return part;
    }

    const result = truncateText(text, capChars);
    if (!result.truncated) {
      return part;
    }

    truncated += 1;
    return { ...(part as Record<string, unknown>), text: result.text } as UIMessagePart;
  });

  return truncated > 0 ? { message: { ...message, parts }, truncated } : { message, truncated: 0 };
}

/**
 * Deterministically reduces a provider view until it fits `inputBudgetTokens`.
 *
 * This is the hard guarantee the tiered optimizer lacks: Tier-1 only prunes
 * large tool outputs outside the recent window, and Tier-2 compaction is
 * conditional (skipped when blocked or on error). When those are bypassed the
 * full history would otherwise be sent verbatim and the provider rejects it
 * with HTTP 400. This pass runs unconditionally as the final step and, oldest
 * first, escalates: elide tool outputs -> drop whole messages -> hard-truncate
 * oversized text parts (including the preserved window and the latest user
 * message, closing the "one giant message" hole). Pure and idempotent: a view
 * already within budget is returned unchanged.
 *
 * Full session history on disk is never touched — only the provider view.
 */
export function fitMessagesToBudget(
  messages: readonly UIMessage[],
  options: FitToBudgetOptions,
): FitToBudgetResult {
  const budget = Math.max(0, Math.floor(options.inputBudgetTokens));
  const preserveRecentMessages = Math.max(0, options.preserveRecentMessages);

  let working: UIMessage[] = [...messages];
  let elidedToolOutputs = 0;
  let droppedMessages = 0;
  let truncatedTextParts = 0;

  const fits = () => estimateStructuralTokens(working) <= budget;

  if (fits()) {
    return {
      messages: working,
      elidedToolOutputs: 0,
      droppedMessages: 0,
      truncatedTextParts: 0,
      estimatedTokens: estimateStructuralTokens(working),
      fitted: false,
      withinBudget: true,
    };
  }

  // Step A — elide tool outputs in non-preserved messages, oldest first.
  const preserveFrom = Math.max(0, working.length - preserveRecentMessages);
  for (let index = 0; index < preserveFrom && !fits(); index += 1) {
    const { message, elided } = elideToolOutputsInMessage(working[index]);
    if (elided > 0) {
      working[index] = message;
      elidedToolOutputs += elided;
    }
  }

  // Step B — drop oldest non-preserved messages. The first message is kept when
  // it is a compaction summary (it carries the only record of dropped turns).
  const firstIsSummary = isSummaryMessage(working[0]);
  let dropFrom = firstIsSummary ? 1 : 0;
  while (
    !fits() &&
    working.length - dropFrom > preserveRecentMessages &&
    dropFrom < working.length
  ) {
    working.splice(dropFrom, 1);
    droppedMessages += 1;
  }

  // Step C — last resort: elide ALL remaining tool outputs (including the
  // preserved window), then hard-truncate text parts with a shrinking cap until
  // the view fits or the cap floor is reached. Guarantees termination.
  if (!fits()) {
    working = working.map((message) => {
      const { message: elidedMessage, elided } = elideToolOutputsInMessage(message);
      elidedToolOutputs += elided;
      return elidedMessage;
    });

    let cap = MAX_TOOL_TEXT_OUTPUT_CHARS;
    while (!fits() && cap >= MIN_TRUNCATION_CAP_CHARS) {
      working = working.map((message) => {
        const { message: truncatedMessage, truncated } = truncateTextPartsInMessage(
          message,
          cap,
        );
        truncatedTextParts += truncated;
        return truncatedMessage;
      });
      cap = Math.floor(cap / 2);
    }
  }

  return {
    messages: working,
    elidedToolOutputs,
    droppedMessages,
    truncatedTextParts,
    estimatedTokens: estimateStructuralTokens(working),
    fitted:
      elidedToolOutputs > 0 || droppedMessages > 0 || truncatedTextParts > 0,
    withinBudget: fits(),
  };
}

/**
 * A compaction summary message carries the dense recap of dropped turns and
 * must survive the drop pass. createSummaryMessage stamps it with a stable id.
 */
function isSummaryMessage(message: UIMessage | undefined): boolean {
  return message?.id === contextSummaryMessageId;
}
