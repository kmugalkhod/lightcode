/** A complete user turn: one user message and everything up to the next user. */
export interface ConversationTurnRange {
  startIndex: number;
  endIndex: number;
  estimatedTokens: number;
}

interface RoleMessage {
  role: string;
}

/**
 * Finds complete user-turn ranges without assuming user/assistant alternation.
 * Tool messages and multi-assistant continuations remain attached to the user
 * message that caused them.
 */
export function collectConversationTurnRanges<T extends RoleMessage>(
  messages: readonly T[],
  estimateMessageTokens: (message: T) => number,
  startIndex = 0,
): ConversationTurnRange[] {
  const ranges: ConversationTurnRange[] = [];
  let turnStart = -1;
  let turnTokens = 0;

  for (let index = Math.max(0, startIndex); index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "user") {
      if (turnStart >= 0) {
        ranges.push({
          startIndex: turnStart,
          endIndex: index,
          estimatedTokens: turnTokens,
        });
      }
      turnStart = index;
      turnTokens = 0;
    }

    if (turnStart >= 0) {
      turnTokens += estimateMessageTokens(message);
    }
  }

  if (turnStart >= 0) {
    ranges.push({
      startIndex: turnStart,
      endIndex: messages.length,
      estimatedTokens: turnTokens,
    });
  }

  return ranges;
}

/**
 * Returns the start of the newest complete-turn suffix that fits the token
 * budget. The latest turn is always retained intact, even when it alone is
 * over budget; the caller can then surface `context_input_too_large` instead
 * of silently cutting the user's request.
 */
export function computeRecentTurnStartIndex<T extends RoleMessage>(
  messages: readonly T[],
  preserveRecentTokens: number,
  estimateMessageTokens: (message: T) => number,
  startIndex = 0,
): number {
  const ranges = collectConversationTurnRanges(
    messages,
    estimateMessageTokens,
    startIndex,
  );
  if (ranges.length === 0) {
    return Math.max(0, startIndex);
  }

  let preservedStart = ranges[ranges.length - 1].startIndex;
  let preservedTokens = ranges[ranges.length - 1].estimatedTokens;
  const budget = Math.max(0, preserveRecentTokens);

  for (let index = ranges.length - 2; index >= 0; index -= 1) {
    const range = ranges[index];
    if (preservedTokens + range.estimatedTokens > budget) {
      break;
    }
    preservedStart = range.startIndex;
    preservedTokens += range.estimatedTokens;
  }

  return preservedStart;
}
