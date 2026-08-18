import type { UIMessage } from "ai";
import {
  resolveContextWindowTokens,
  resolveInputBudgetTokens,
  resolvePreserveRecentTokens,
  type ResolvedContextOptimizerConfig,
} from "./config";
import type { ContextStateView } from "./context-state";
import {
  ESTIMATED_CHARS_PER_TOKEN,
  estimateMessageTokens,
  estimateProviderMessageTokens,
  type ContextTokenEstimate,
} from "./estimate";
import { estimateStructuralTokens } from "./fit-to-budget";
import { createSummaryMessage } from "./heuristic-summary";
import { hasUnresolvedToolWork } from "./message-parts";
import { pruneToolOutputs, type Tier1PruneResult } from "./tier1-prune";
import {
  collectConversationTurnRanges,
  computeRecentTurnStartIndex,
} from "./turns";

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
  /**
   * Tokens reserved for the model's output. The provider counts input + output
   * against the same window, so this is subtracted from the input budget.
   */
  reservedOutputTokens?: number | null;
  /**
   * Hard endpoint limit learned from a provider overflow error, used to clamp
   * an optimistic catalog window down to the real serving limit.
   */
  endpointLimitTokens?: number | null;
  /**
   * Exact input-token count from a provider that can measure it (Anthropic's
   * countTokens). When present it joins the compaction-trigger floor — never
   * the displayed estimate. Absent for providers without a count API.
   */
  measuredInputTokens?: number | null;
  pendingInteractionCount?: number;
  /**
   * Whether the active provider benefits from prompt caching. When false (e.g.
   * OpenRouter), Tier-1 prunes more aggressively — there is no byte-stable
   * prefix to protect. Defaults to true, preserving the conservative behavior.
   */
  cacheActive?: boolean;
  /** System prompt plus the active tool grammar for the final request. */
  fixedInputTokens?: number;
}

export interface ProviderViewResult {
  /** Messages to send to the provider. */
  providerMessages: UIMessage[];
  estimate: ContextTokenEstimate;
  contextWindow: number;
  /**
   * Hard input-token budget for the assembled request: the (endpoint-clamped)
   * window minus reserved output minus a safety margin. The ceiling the
   * deterministic fit-to-budget clamp must satisfy.
   */
  inputBudgetTokens: number;
  /** Portion of the input budget available to messages after fixed overhead. */
  messageBudgetTokens: number;
  /** Stable system-prompt and active-tool overhead included in `estimate`. */
  fixedInputTokens: number;
  /** Effective token-bounded recent tail for this model request. */
  preserveRecentTokens: number;
  /** True when a (new) Tier-2 compaction should run before streaming. */
  needsCompaction: boolean;
  /**
   * True when an uncached session has accumulated enough user turns past the
   * anchor that its oldest turns should be folded into the summary — run after
   * the turn completes (off the request path), independent of context pressure.
   */
  needsRollingCompaction: boolean;
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

/**
 * Token-bounded replacement for message-count retention. The cutoff always
 * starts on a user boundary, so a tool call/result sequence is never split
 * across the stored summary and the verbatim recent tail.
 */
export function computeTokenBoundedCompactionCutoffIndex(
  messages: readonly UIMessage[],
  preserveRecentTokens: number,
  afterAnchorIndex: number,
): number {
  return computeRecentTurnStartIndex(
    messages,
    preserveRecentTokens,
    estimateMessageTokens,
    afterAnchorIndex,
  );
}

/**
 * Caps a covered slice to the leading run of (whole) messages whose combined
 * structural token estimate stays within `maxTokens`. Always keeps at least one
 * message so a single oversized turn still gets compacted (the summarizer
 * truncates its own transcript). Folding the oldest chunk first lets the anchor
 * advance each round, so the remainder compacts on later iterations.
 */
export function capCoverageToTokenBudget(
  coveredMessages: readonly UIMessage[],
  maxTokens: number,
): UIMessage[] {
  if (coveredMessages.length <= 1) {
    return [...coveredMessages];
  }

  const turns = collectConversationTurnRanges(
    coveredMessages,
    estimateMessageTokens,
  );
  if (turns.length === 0) {
    return [...coveredMessages];
  }

  let total = 0;
  let endIndex = 0;
  for (const turn of turns) {
    if (endIndex > 0 && total + turn.estimatedTokens > maxTokens) {
      break;
    }
    endIndex = turn.endIndex;
    total += turn.estimatedTokens;
  }

  return coveredMessages.slice(0, endIndex);
}

export function buildProviderView(
  options: BuildProviderViewOptions,
): ProviderViewResult {
  const { messages, contextState, config } = options;
  const contextWindow = resolveContextWindowTokens({
    config,
    modelContextWindow: options.modelContextWindow,
    endpointLimitTokens: options.endpointLimitTokens,
  });
  const inputBudgetTokens = resolveInputBudgetTokens({
    contextWindow,
    reservedOutputTokens: options.reservedOutputTokens,
  });
  const fixedInputTokens = Math.max(
    0,
    Math.floor(options.fixedInputTokens ?? 0),
  );
  const messageBudgetTokens = Math.max(0, inputBudgetTokens - fixedInputTokens);
  const preserveRecentTokens = resolvePreserveRecentTokens({
    config,
    inputBudgetTokens: messageBudgetTokens,
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

  const messageEstimate = estimateProviderMessageTokens(providerMessages, {
    fallbackFixedInputTokens: fixedInputTokens,
  });
  let estimate: ContextTokenEstimate = {
    tokens: messageEstimate.tokens + fixedInputTokens,
    basis: messageEstimate.basis,
  };
  let tier1: Tier1PruneResult | null = null;

  // With no prompt cache to protect, prune sooner and harder: the cache-warming
  // quantization and high char threshold only cost tokens here.
  const uncachedActive =
    options.cacheActive === false && config.aggressivePruneWhenUncached;
  const pruneFraction = uncachedActive
    ? config.uncachedPruneAtFraction
    : config.pruneAtFraction;

  // The usage-calibrated estimate under-reports when the summary anchor is lost
  // (it reflects the narrow view the provider last saw, not the reassembled
  // full history). The structural estimate is monotonic in the real payload, so
  // floor the trigger with it — and the exact measured count when a provider
  // can supply one. Only the *decision* uses this floor; `estimate` remains the
  // displayed number.
  const triggerTokens = (currentEstimateTokens: number) =>
    Math.max(
      currentEstimateTokens,
      estimateStructuralTokens(providerMessages) + fixedInputTokens,
      typeof options.measuredInputTokens === "number"
        ? options.measuredInputTokens
        : 0,
    );

  // Without a cache the full history is re-billed every turn, so waiting for
  // context pressure only accumulates cost: prune unconditionally from turn 1.
  const shouldPrune =
    uncachedActive ||
    triggerTokens(estimate.tokens) > pruneFraction * inputBudgetTokens;

  if (shouldPrune) {
    const recentStart = computeRecentTurnStartIndex(
      providerMessages,
      preserveRecentTokens,
      estimateMessageTokens,
    );
    tier1 = pruneToolOutputs(providerMessages, {
      // Tier-1 still accepts a count internally, but derive that count from the
      // token-bounded complete-turn suffix. No request path retains history by
      // an arbitrary number of messages anymore.
      preserveRecentMessages: providerMessages.length - recentStart,
      minOutputChars: uncachedActive
        ? config.uncachedPruneMinOutputChars
        : undefined,
      // The cutoff is already snapped to a complete user turn. A second
      // quantization pass can move it backwards past an oversized tool result
      // and defeat the token ceiling entirely.
      quantizeUserTurns: 1,
      dedupeAcrossFullHistory: uncachedActive,
      elideReasoningParts: uncachedActive,
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

  const tokenBoundedCutoffIndex = computeTokenBoundedCompactionCutoffIndex(
    messages,
    preserveRecentTokens,
    afterAnchorIndex,
  );
  const userIndicesAfterAnchor = messages
    .map((message, index) => ({ message, index }))
    .filter(
      ({ message, index }) =>
        index >= afterAnchorIndex && message.role === "user",
    )
    .map(({ index }) => index);
  const rollingTurnCutoffIndex =
    userIndicesAfterAnchor.length > config.uncachedRollingCompactionUserTurns
      ? (userIndicesAfterAnchor[
          userIndicesAfterAnchor.length -
            config.uncachedRollingCompactionUserTurns
        ] ?? afterAnchorIndex)
      : afterAnchorIndex;
  // Cap each round to a token budget so the summarizer's own input stays bounded
  // on huge sessions. The uncovered remainder stays in the provider view and is
  // folded in on the next iterative round (see chat-stream's compaction loop).
  const overCompactThreshold =
    triggerTokens(estimate.tokens) >
    config.compactAtFraction * inputBudgetTokens;

  // Rolling trigger for uncached sessions: fold history into the summary once
  // enough user turns have piled up past the anchor, regardless of pressure —
  // per-turn input then plateaus at summary + recent window instead of growing.
  const userTurnsAfterAnchor = messages
    .slice(afterAnchorIndex)
    .filter((message) => message.role === "user").length;
  const rollingThresholdReached =
    uncachedActive &&
    userTurnsAfterAnchor > config.uncachedRollingCompactionUserTurns;
  const compactionCutoffIndex = rollingThresholdReached
    ? Math.max(tokenBoundedCutoffIndex, rollingTurnCutoffIndex)
    : tokenBoundedCutoffIndex;
  const coveredMessages = capCoverageToTokenBudget(
    messages.slice(afterAnchorIndex, compactionCutoffIndex),
    config.maxCoverageTokensPerCompaction,
  );

  let compactionBlockedReason: CompactionBlockedReason | null = null;
  if (overCompactThreshold || rollingThresholdReached) {
    if (coveredMessages.length === 0) {
      compactionBlockedReason = "not_enough_messages";
    } else if ((options.pendingInteractionCount ?? 0) > 0) {
      compactionBlockedReason = "pending_interactions";
    } else if (hasUnresolvedToolWork(coveredMessages)) {
      // Scope the check to the slice we'd actually summarize. Unresolved work in
      // the *preserved* tail (a genuinely in-flight tool call) must not wedge
      // compaction of older, settled history. normalizeProviderMessages remains
      // the backstop that neutralizes any dangling call before it reaches the
      // provider.
      compactionBlockedReason = "unresolved_tool_work";
    }
  }

  return {
    providerMessages,
    estimate,
    contextWindow,
    inputBudgetTokens,
    messageBudgetTokens,
    fixedInputTokens,
    preserveRecentTokens,
    needsCompaction: overCompactThreshold && compactionBlockedReason === null,
    needsRollingCompaction:
      rollingThresholdReached && compactionBlockedReason === null,
    compactionBlockedReason,
    anchorResolved,
    coveredMessages,
    compactionCutoffIndex,
    tier1,
  };
}
