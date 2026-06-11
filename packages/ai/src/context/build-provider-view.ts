import type { UIMessage } from "ai";
import {
  resolveContextWindowTokens,
  type ResolvedContextOptimizerConfig,
} from "./config";
import type { ContextStateView } from "./context-state";
import {
  ESTIMATED_CHARS_PER_TOKEN,
  estimateContextTokens,
  type ContextTokenEstimate,
} from "./estimate";
import { createSummaryMessage } from "./heuristic-summary";
import { hasUnresolvedToolWork } from "./message-parts";
import { pruneToolOutputs, type Tier1PruneResult } from "./tier1-prune";

export type CompactionBlockedReason =
  | "not_enough_messages"
  | "pending_interactions"
  | "unresolved_tool_work";

export interface BuildProviderViewOptions {
  /** Full session history as sent by the client. */
  messages: readonly UIMessage[];
  /** Stored compaction state for the session, if any. */
  contextState: ContextStateView | null;
  config: ResolvedContextOptimizerConfig;
  /** Context window of the active model in tokens, when known. */
  modelContextWindow?: number | null;
  pendingInteractionCount?: number;
}

export interface ProviderViewResult {
  /** Messages to send to the provider. */
  providerMessages: UIMessage[];
  estimate: ContextTokenEstimate;
  contextWindow: number;
  /** True when a (new) Tier-2 compaction should run before streaming. */
  needsCompaction: boolean;
  compactionBlockedReason: CompactionBlockedReason | null;
  /** True when the stored summary anchor was found in the incoming history. */
  anchorResolved: boolean;
  /**
   * Full-history messages a new compaction would cover (everything after the
   * stored anchor up to the compaction cutoff). Empty when nothing to compact.
   */
  coveredMessages: UIMessage[];
  /** Index into the full history where the preserved window starts. */
  compactionCutoffIndex: number;
  tier1: Tier1PruneResult | null;
}

/**
 * Compaction cutoff into the full history: keeps at least
 * `preserveRecentMessages` recent messages and snaps down to a user-message
 * boundary so the preserved window starts with a user turn.
 */
export function computeCompactionCutoffIndex(
  messages: readonly UIMessage[],
  preserveRecentMessages: number,
  afterAnchorIndex: number,
): number {
  const candidate = messages.length - preserveRecentMessages;
  if (candidate <= afterAnchorIndex) {
    return afterAnchorIndex;
  }

  for (let index = candidate; index > afterAnchorIndex; index -= 1) {
    if (messages[index]?.role === "user") {
      return index;
    }
  }

  return afterAnchorIndex;
}

export function buildProviderView(
  options: BuildProviderViewOptions,
): ProviderViewResult {
  const { messages, contextState, config } = options;
  const contextWindow = resolveContextWindowTokens({
    config,
    modelContextWindow: options.modelContextWindow,
  });

  let anchorResolved = false;
  let afterAnchorIndex = 0;
  let providerMessages: UIMessage[];

  if (contextState) {
    const anchorIndex = messages.findIndex(
      (message) => message.id === contextState.anchorMessageId,
    );
    if (anchorIndex >= 0) {
      anchorResolved = true;
      afterAnchorIndex = anchorIndex + 1;
      providerMessages = [
        createSummaryMessage(contextState.summary),
        ...messages.slice(afterAnchorIndex),
      ];
    } else {
      providerMessages = [...messages];
    }
  } else {
    providerMessages = [...messages];
  }

  let estimate = estimateContextTokens(providerMessages);
  let tier1: Tier1PruneResult | null = null;

  if (estimate.tokens > config.pruneAtFraction * contextWindow) {
    tier1 = pruneToolOutputs(providerMessages, {
      preserveRecentMessages: config.preserveRecentMessages,
    });

    if (tier1.savedChars > 0) {
      providerMessages = tier1.messages;
      // Usage-calibrated estimates cannot observe pruning (the provider has
      // not seen the pruned view yet), so apply the savings directly.
      estimate = {
        tokens: Math.max(
          0,
          estimate.tokens -
            Math.round(tier1.savedChars / ESTIMATED_CHARS_PER_TOKEN),
        ),
        basis: estimate.basis,
      };
    }
  }

  const compactionCutoffIndex = computeCompactionCutoffIndex(
    messages,
    config.preserveRecentMessages,
    afterAnchorIndex,
  );
  const coveredMessages = messages.slice(afterAnchorIndex, compactionCutoffIndex);

  const overCompactThreshold =
    estimate.tokens > config.compactAtFraction * contextWindow;

  let compactionBlockedReason: CompactionBlockedReason | null = null;
  if (overCompactThreshold) {
    if (coveredMessages.length === 0) {
      compactionBlockedReason = "not_enough_messages";
    } else if ((options.pendingInteractionCount ?? 0) > 0) {
      compactionBlockedReason = "pending_interactions";
    } else if (hasUnresolvedToolWork(messages)) {
      compactionBlockedReason = "unresolved_tool_work";
    }
  }

  return {
    providerMessages,
    estimate,
    contextWindow,
    needsCompaction: overCompactThreshold && compactionBlockedReason === null,
    compactionBlockedReason,
    anchorResolved,
    coveredMessages,
    compactionCutoffIndex,
    tier1,
  };
}
