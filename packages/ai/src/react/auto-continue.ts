import type { UIMessage } from "ai";
import { getMessageUsageMetadata } from "../context/estimate";
import type { TodoItem } from "../todo-write/schema";

/**
 * Decides whether the agent should keep going after a response finished,
 * without any user action. The turn ends only when the model finished
 * cleanly with no signs of unfinished work, when the agent is blocked on
 * user input, or when a loop guard trips.
 */

export type AutoContinueKind = "continue-length" | "nudge-stop" | "none";

export interface AutoContinueDecision {
  kind: AutoContinueKind;
  prompt?: string;
  /** Set when a loop guard stopped continuation that would otherwise fire. */
  guardTripped?: "max-continues" | "doom-loop";
}

export interface AutoContinueLimits {
  enabled: boolean;
  maxAutoContinues: number;
}

export const defaultAutoContinueLimits: AutoContinueLimits = {
  enabled: true,
  maxAutoContinues: 50,
};

export const continueAfterLengthPrompt =
  "Your previous response was cut off by the output token limit. Continue exactly where you left off. Do not repeat completed work.";

export const nudgeAfterPrematureStopPrompt =
  "You stopped before completing the task. Review your todo list and continue working until every item is complete. Call tools through the function-calling interface, never as XML or plain text.";

/** Trailing text that signals the model intended to keep working. */
const INTENT_TO_CONTINUE_RE =
  /(?::|\b(?:let me|i'll now|i will now|next,? i(?:'ll| will)|now i(?:'ll| will)|going to|proceeding to|let's)\s*[\w,' ]*)$/i;

const DOOM_LOOP_WINDOW = 3;
const DOOM_LOOP_PREFIX_CHARS = 200;

function collectMessageText(message: UIMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function lastAssistantMessage(messages: readonly UIMessage[]): UIMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      return messages[i];
    }
  }
  return null;
}

export function hasUnfinishedTodos(todos: readonly TodoItem[]): boolean {
  return todos.some(
    (todo) => todo.status === "pending" || todo.status === "in_progress",
  );
}

export function showsIntentToContinue(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return INTENT_TO_CONTINUE_RE.test(trimmed);
}

/**
 * Fingerprint of an assistant message used for doom-loop detection: text
 * prefix plus tool-call names/inputs.
 */
export function assistantResponseFingerprint(message: UIMessage): string {
  const text = collectMessageText(message).trim().slice(0, DOOM_LOOP_PREFIX_CHARS);
  const toolParts = message.parts
    .filter((part) => part.type.startsWith("tool-"))
    .map((part) => {
      const toolPart = part as { type: string; input?: unknown };
      return `${toolPart.type}:${JSON.stringify(toolPart.input ?? null)}`;
    })
    .join("|");
  return `${text}::${toolParts}`;
}

/** True when the last `window` assistant responses are near-identical. */
export function isDoomLoop(
  messages: readonly UIMessage[],
  window = DOOM_LOOP_WINDOW,
): boolean {
  const fingerprints: string[] = [];
  for (let i = messages.length - 1; i >= 0 && fingerprints.length < window; i--) {
    if (messages[i].role === "assistant") {
      fingerprints.push(assistantResponseFingerprint(messages[i]));
    }
  }
  if (fingerprints.length < window) return false;
  const [first, ...rest] = fingerprints;
  if (!first.trim() || first === "::") return false;
  return rest.every((fp) => fp === first);
}

/**
 * True when a streaming response has received no chunks for longer than the
 * stall timeout and should be aborted + retried.
 */
export function shouldTreatAsStalled({
  lastActivityAt,
  now,
  stallTimeoutMs,
}: {
  lastActivityAt: number;
  now: number;
  stallTimeoutMs: number;
}): boolean {
  return stallTimeoutMs > 0 && now - lastActivityAt >= stallTimeoutMs;
}

export interface DecideAutoContinueOptions {
  messages: readonly UIMessage[];
  todos: readonly TodoItem[];
  autoContinuesThisTurn: number;
  limits?: AutoContinueLimits;
}

export function decideAutoContinue({
  messages,
  todos,
  autoContinuesThisTurn,
  limits = defaultAutoContinueLimits,
}: DecideAutoContinueOptions): AutoContinueDecision {
  if (!limits.enabled) {
    return { kind: "none" };
  }

  const lastAssistant = lastAssistantMessage(messages);
  if (!lastAssistant) {
    return { kind: "none" };
  }

  const metadata = getMessageUsageMetadata(lastAssistant);
  const finishReason = metadata?.finishReason;
  const toolIntent = (metadata as { toolIntent?: string } | null)?.toolIntent;

  const wantsContinuation =
    finishReason === "length"
      ? ("continue-length" as const)
      : finishReason === "stop" &&
          (toolIntent === "unparsed" ||
            hasUnfinishedTodos(todos) ||
            showsIntentToContinue(collectMessageText(lastAssistant)))
        ? ("nudge-stop" as const)
        : null;

  if (!wantsContinuation) {
    return { kind: "none" };
  }

  if (autoContinuesThisTurn >= limits.maxAutoContinues) {
    return { kind: "none", guardTripped: "max-continues" };
  }

  if (isDoomLoop(messages)) {
    return { kind: "none", guardTripped: "doom-loop" };
  }

  return wantsContinuation === "continue-length"
    ? { kind: "continue-length", prompt: continueAfterLengthPrompt }
    : { kind: "nudge-stop", prompt: nudgeAfterPrematureStopPrompt };
}
