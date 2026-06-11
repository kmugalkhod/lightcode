import type { UIMessage } from "ai";

/**
 * Reattaches messages produced by a stream (which ran against the compacted
 * provider view) to the full session history so persistence never loses
 * compacted-away messages.
 */
export function mergeFinishedMessagesIntoFullHistory({
  fullMessages,
  providerMessageCount,
  finishedMessages,
  isContinuation,
  responseMessage,
}: {
  /** Full history as received from the client (already persisted pre-stream). */
  fullMessages: readonly UIMessage[];
  /** Number of messages in the provider view the stream ran against. */
  providerMessageCount: number;
  /** Final messages reported by the stream (provider view + response). */
  finishedMessages: readonly UIMessage[];
  isContinuation: boolean;
  responseMessage: UIMessage;
}): UIMessage[] {
  if (isContinuation) {
    // The response extended the trailing assistant message, which is shared
    // between the provider view and the full history.
    const lastMessage = fullMessages[fullMessages.length - 1];
    const base =
      lastMessage && lastMessage.role === "assistant"
        ? fullMessages.slice(0, -1)
        : [...fullMessages];
    return [...base, responseMessage];
  }

  const appendedMessages = finishedMessages.slice(providerMessageCount);
  return [...fullMessages, ...appendedMessages];
}
