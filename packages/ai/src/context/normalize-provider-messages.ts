import { isToolUIPart, type UIMessage } from "ai";

/** Tool UI states that already carry a result and are safe to send. */
const terminalToolStates = new Set([
  "output-available",
  "output-error",
  "output-denied",
]);

export const interruptedToolErrorText =
  "Tool call was interrupted by a connection retry. Re-issue the tool call if it is still needed.";

/**
 * True when any message still holds a tool call without a terminal result.
 * OpenAI- and Anthropic-compatible providers reject such histories (a
 * dangling `tool_use`/`tool_call` with no paired result) with HTTP 400.
 */
export function hasDanglingToolParts(messages: readonly UIMessage[]): boolean {
  return messages.some((message) =>
    message.parts.some(
      (part) => isToolUIPart(part) && !terminalToolStates.has(part.state),
    ),
  );
}

/**
 * Rewrites every tool call left without a terminal result to a synthesized
 * error result, so a provider never receives a dangling tool call.
 *
 * Count-preserving: only part *states* change, never the number of messages,
 * so callers that rely on the message count (e.g. the finished-message merge,
 * which slices appended messages by provider-view length) stay correct.
 */
export function resolveDanglingToolParts(
  messages: readonly UIMessage[],
  errorText = interruptedToolErrorText,
): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") {
      return message as UIMessage;
    }

    let changed = false;
    const parts = message.parts.map((part) => {
      if (!isToolUIPart(part) || terminalToolStates.has(part.state)) {
        return part;
      }

      changed = true;
      return {
        ...part,
        state: "output-error",
        errorText,
      } as unknown as typeof part;
    });

    return changed ? ({ ...message, parts } as UIMessage) : (message as UIMessage);
  });
}

/**
 * Server-side payload guard applied to the exact provider view immediately
 * before every model call — first send, auto-continue, and retry alike.
 * Whatever code path built the view (compaction summary + tail, tier1 prune,
 * overflow recovery, or a raw history), this guarantees no dangling tool call
 * reaches the provider, which is the structural cause of "payload is not
 * correct" 400s. It is the server-side, always-on counterpart to the client's
 * retry-time `sanitizeMessagesForRetry`.
 */
export function normalizeProviderMessages(
  messages: readonly UIMessage[],
): UIMessage[] {
  return resolveDanglingToolParts(messages);
}
