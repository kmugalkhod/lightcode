import {
  buildProviderView,
  collectMessageText,
  estimateStructuralTokens,
  fitMessagesToBudget,
  formatChatStreamError,
  lightcodeConfigDefaults,
  listSkills,
  normalizeProviderMessages,
  resolveMaxOutputTokens,
  selectCodingAgentIntentTools,
  type CodingAgentMode,
  type CodingAgentToolName,
  type PermissionMode,
  type PermissionRules,
  type SandboxConfig,
  type SessionContextState,
  type SessionMessagesResponse,
} from "@lightcode/ai";
import { createLogger, getErrorMessage } from "@lightcode/shared";
import {
  createAgentUIStreamResponse,
  consumeStream,
  generateId,
  isToolUIPart,
  safeValidateUIMessages,
  streamText,
  type TextStreamPart,
  type ToolSet,
  type UIMessage,
} from "ai";
import type { Context } from "hono";
import {
  chatFailureClassForErrorKind,
  classifyChatError,
  incrementChatFailureCounter,
  isDisconnectOrTimeoutError,
  logChatDisconnectEvent,
  logChatStreamErrorEvent,
  logChatWriteEvent,
} from "./chat-observability";
import { mergeFinishedMessagesIntoFullHistory } from "./chat-history-merge";
import { listChatInteractions } from "./chat-interaction-store";
import {
  persistChatMessages,
  resolveChatSessionIdentifier,
  SessionNotFoundError,
} from "./chat-store";
import { compactSessionContext } from "./context-compaction";
import {
  clearContextOverflowRounds,
  getOverflowPreserveRecentMessages,
  noteContextOverflow,
} from "./overflow-recovery";
import {
  getLearnedContextLimit,
  noteLearnedContextLimit,
} from "./learned-context-limit";
import { withSseHeartbeat } from "./sse-heartbeat";
import { getSessionContextState } from "./context-state-store";
import { maybeScheduleSessionAutoTitle } from "./session-auto-title";
import {
  buildWorkspaceContext,
  buildWorkspaceContextDelta,
} from "./workspace-context";
import {
  chatModelId,
  codingAgent,
  lightcodeConfigResult,
  resolvedProviderModel,
} from "./runtime-config";

const logger = createLogger("chat-stream");

const recoverableDisconnectMessage =
  "Connection interrupted. Please retry or regenerate your last message.";
const providerBillingOrQuotaMessage =
  "The configured model provider rejected this request due to billing or quota limits. " +
  "Update provider credits/quota and retry.";

const fastChatSystemPrompt =
  "You are Lightcode's coding assistant, running inside the user's project. " +
  "For casual conversation, reply briefly and naturally. " +
  "If the user asks about or wants work on their code, do not ask them to paste it — you can read the project files directly; offer to look and proceed.";
const fastChatMaxOutputTokens = 512;
const fastChatRecentMessageCount = 6;
// Upper bound on iterative Tier-2 compaction rounds per turn. The anchor
// advances each round so compaction terminates on its own; this only caps
// worst-case latency from repeated summarizer calls.
const MAX_COMPACTION_ROUNDS = 3;

// Sessions with a background rolling compaction in flight. One writer per
// session at a time; a skipped run is retried after the next turn anyway.
const rollingCompactionInFlight = new Set<string>();

function isEmptyAssistantMessage(message: UIMessage) {
  return message.role === "assistant" && message.parts.length === 0;
}

function removeTrailingEmptyAssistantMessages(messages: UIMessage[]) {
  let endIndex = messages.length;

  while (endIndex > 0 && isEmptyAssistantMessage(messages[endIndex - 1])) {
    endIndex -= 1;
  }

  return endIndex === messages.length ? messages : messages.slice(0, endIndex);
}

function buildFastChatModelMessages(messages: UIMessage[]) {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role,
      content: collectMessageText(message),
    }))
    .filter((message) => message.content.length > 0)
    .slice(-fastChatRecentMessageCount);
}

/** True once the agent has produced any tool call/result in this session. */
function messagesHaveToolActivity(messages: UIMessage[]): boolean {
  return messages.some((message) =>
    message.parts?.some((part) => isToolUIPart(part)),
  );
}

export function shouldUseFastChatPath({
  messages,
  mode,
  allowedTools,
  availableSkillNames = [],
}: {
  messages: UIMessage[];
  mode: CodingAgentMode;
  allowedTools: CodingAgentToolName[] | undefined;
  availableSkillNames?: readonly string[];
}) {
  if (allowedTools && allowedTools.length > 0) {
    return false;
  }

  // Once the agent has used tools in this session, a follow-up — even a terse
  // "continue" — is almost certainly resuming that work and must run the full
  // agent loop, not the tool-less fast path. The keyword-based intent selector
  // only inspects the latest user message, so short continuations would
  // otherwise misroute here and reply once without executing anything.
  if (messagesHaveToolActivity(messages)) {
    return false;
  }

  return selectCodingAgentIntentTools({
    mode,
    prompt: "",
    messages,
    availableSkillNames,
  }).length === 0;
}

async function countPendingChatInteractions(sessionId: string) {
  try {
    const pendingInteractions = await listChatInteractions({
      sessionId,
      status: "pending",
    });

    return pendingInteractions.interactions.length;
  } catch (error) {
    logger.warn("context_compaction_pending_interactions_unavailable", {
      sessionId,
      error: getErrorMessage(error),
    });

    return 1;
  }
}

export async function loadSessionContextStateSafe(
  sessionId: string,
): Promise<SessionContextState | null> {
  try {
    return await getSessionContextState(sessionId);
  } catch (error) {
    logger.warn("context_state_unavailable", {
      sessionId,
      error: getErrorMessage(error),
    });

    return null;
  }
}

export async function streamSessionChat(
  c: Context,
  sessionIdentifier: string,
  messagesPayload: SessionMessagesResponse["messages"],
  cwd: string,
  mode: CodingAgentMode,
  permissionMode: PermissionMode | undefined,
  allowedTools: CodingAgentToolName[] | undefined,
  permissionRules: PermissionRules | undefined,
  sandbox: SandboxConfig | undefined,
) {
  const validatedMessagesResult = await safeValidateUIMessages({
    messages: messagesPayload,
  });

  if (!validatedMessagesResult.success) {
    return c.json({ error: "Invalid chat messages payload." }, 400);
  }

  // Keep the server usable for onboarding when no credentials exist yet, but
  // reject chat attempts with a recognizable error code.
  if (resolvedProviderModel.missingCredentialHints.length > 0) {
    return c.json(
      {
        error: "No provider credentials are configured.",
        code: "missing_credentials",
        hints: resolvedProviderModel.missingCredentialHints,
      },
      503,
    );
  }

  let sessionId: string;
  try {
    sessionId = await resolveChatSessionIdentifier(sessionIdentifier);
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return c.json({ error: error.message }, 404);
    }

    throw error;
  }

  const validatedMessages = validatedMessagesResult.data;

  // The full history is persisted before any optimization so compaction can
  // never destroy session history; only the provider view is reduced.
  let baseRevision = 0;

  try {
    const persistResult = await persistChatMessages({
      sessionId,
      messages: validatedMessages,
      assistantModel: chatModelId,
      cwd,
      mode,
      permissionMode: permissionMode ?? null,
    });
    baseRevision = persistResult.revision;
    logChatWriteEvent({
      sessionId,
      revision: persistResult.revision,
      phase: "pre-stream",
      staleSkip: false,
    });
  } catch (error) {
    logger.error("chat_pre_stream_persist_failed", {
      sessionId,
      error: getErrorMessage(error),
    });
    return c.json(
      {
        error: "Unable to persist incoming chat messages.",
        details: Bun.env.NODE_ENV === "production" ? undefined : getErrorMessage(error),
      },
      500
    );
  }

  const contextConfig = lightcodeConfigResult.config.context;
  // Prompt caching (direct Anthropic, or OpenRouter Anthropic-family with
  // cache_control set) needs a byte-stable prefix to hit; elsewhere there is
  // nothing to protect, so Tier-1 may prune more aggressively.
  const cacheActive = resolvedProviderModel.supportsPromptCaching;
  // The provider counts input + output against the same window, so the input
  // budget must subtract what we reserve for output (resolveMaxOutputTokens
  // grants the model's full advertised cap when the user left the default).
  const reservedOutputTokens = resolveMaxOutputTokens(
    lightcodeConfigResult.config.maxOutputTokens,
    lightcodeConfigDefaults.maxOutputTokens,
    resolvedProviderModel.maxCompletionTokens,
  );
  // A hard limit learned from a prior overflow on this model, clamping an
  // optimistic catalog window down to the real serving limit.
  const endpointLimitTokens = getLearnedContextLimit(chatModelId);
  const pendingInteractionCount = await countPendingChatInteractions(sessionId);
  let contextState = await loadSessionContextStateSafe(sessionId);
  let view = buildProviderView({
    messages: validatedMessages,
    contextState,
    config: contextConfig,
    modelContextWindow: resolvedProviderModel.contextWindow,
    reservedOutputTokens,
    endpointLimitTokens,
    pendingInteractionCount,
    cacheActive,
  });

  // Iterative compaction: each round folds a bounded chunk (capped by
  // maxCoverageTokensPerCompaction) into the summary and advances the anchor, so
  // a very long session shrinks gracefully over a few rounds instead of handing
  // the summarizer one enormous slice. The anchor advances monotonically so this
  // terminates; MAX_COMPACTION_ROUNDS just bounds per-turn latency, and the
  // fit-to-budget clamp below is the unconditional backstop for whatever remains.
  if (contextConfig.autoCompact) {
    let compactionRound = 0;
    while (view.needsCompaction && compactionRound < MAX_COMPACTION_ROUNDS) {
      compactionRound += 1;
      try {
        const estimatedTokensBefore = view.estimate.tokens;
        const compaction = await compactSessionContext({
          sessionId,
          coveredMessages: view.coveredMessages,
          previousState: contextState,
          model: resolvedProviderModel.model,
          modelId: chatModelId,
          cwd,
          config: contextConfig,
          estimatedTokens: estimatedTokensBefore,
        });
        contextState = compaction.state;
        view = buildProviderView({
          messages: validatedMessages,
          contextState,
          config: contextConfig,
          modelContextWindow: resolvedProviderModel.contextWindow,
          reservedOutputTokens,
          endpointLimitTokens,
          pendingInteractionCount,
          cacheActive,
        });
        logger.info("context_auto_compacted", {
          sessionId,
          round: compactionRound,
          tier: compaction.state.tier,
          usedFallback: compaction.usedFallback,
          coveredMessageCount: compaction.state.coveredMessageCount,
          estimatedTokensBefore,
          estimatedTokensAfter: view.estimate.tokens,
          stillNeedsCompaction: view.needsCompaction,
        });
      } catch (error) {
        // Compaction failures must never block the chat; stream uncompacted and
        // let the fit-to-budget clamp guarantee the request still fits.
        logger.error("context_compaction_failed", {
          sessionId,
          round: compactionRound,
          error: getErrorMessage(error),
        });
        break;
      }
    }
  }

  // Forced overflow-recovery compaction: the previous attempt for this
  // session was rejected as too large, so shrink the view harder than the
  // automatic thresholds would before rebuilding the request.
  const overflowPreserve = getOverflowPreserveRecentMessages(sessionId);
  if (overflowPreserve !== null) {
    const overflowConfig = {
      ...contextConfig,
      preserveRecentMessages: Math.min(
        overflowPreserve,
        contextConfig.preserveRecentMessages,
      ),
    };

    try {
      const overflowView = buildProviderView({
        messages: validatedMessages,
        contextState,
        config: overflowConfig,
        modelContextWindow: resolvedProviderModel.contextWindow,
        reservedOutputTokens,
        endpointLimitTokens,
        pendingInteractionCount: 0,
        cacheActive,
      });

      if (overflowView.coveredMessages.length > 0) {
        const compaction = await compactSessionContext({
          sessionId,
          coveredMessages: overflowView.coveredMessages,
          previousState: contextState,
          model: resolvedProviderModel.model,
          modelId: chatModelId,
          cwd,
          config: overflowConfig,
          estimatedTokens: overflowView.estimate.tokens,
        });
        contextState = compaction.state;
      }

      view = buildProviderView({
        messages: validatedMessages,
        contextState,
        config: overflowConfig,
        modelContextWindow: resolvedProviderModel.contextWindow,
        reservedOutputTokens,
        endpointLimitTokens,
        pendingInteractionCount: 0,
        cacheActive,
      });

      // Health probe: a recovery round that did not actually shrink the view
      // below the window will fail again — make that visible instead of
      // silently burning the client's retry budget.
      logger.info("context_overflow_recovery", {
        sessionId,
        preserveRecentMessages: overflowConfig.preserveRecentMessages,
        estimatedTokens: view.estimate.tokens,
        contextWindow: view.contextWindow,
        withinWindow: view.estimate.tokens < view.contextWindow,
        compactedMessages: view.coveredMessages.length,
      });
    } catch (error) {
      logger.error("context_overflow_recovery_failed", {
        sessionId,
        error: getErrorMessage(error),
      });
    }
  }

  // Hard ceiling: whatever the tiered optimizer produced (compaction can be
  // blocked or fail, Tier-1 only touches large tool outputs), deterministically
  // shrink the view until it fits the input budget. This is the unconditional
  // backstop that makes "request exceeds the context window" structurally
  // impossible, even when every soft tier was bypassed. Only the provider view
  // shrinks; the full history on disk is untouched.
  const fitted = fitMessagesToBudget(view.providerMessages, {
    inputBudgetTokens: view.inputBudgetTokens,
    preserveRecentMessages: contextConfig.preserveRecentMessages,
  });
  if (fitted.fitted) {
    logger.warn("context_fit_to_budget", {
      sessionId,
      inputBudgetTokens: view.inputBudgetTokens,
      contextWindow: view.contextWindow,
      estimatedTokensBefore: estimateStructuralTokens(view.providerMessages),
      estimatedTokensAfter: fitted.estimatedTokens,
      elidedToolOutputs: fitted.elidedToolOutputs,
      droppedMessages: fitted.droppedMessages,
      truncatedTextParts: fitted.truncatedTextParts,
      withinBudget: fitted.withinBudget,
    });
  }

  // Final payload guard: whatever path built the view (compaction, tier1
  // prune, overflow recovery, the fit clamp above, or raw history), never hand
  // the provider a dangling tool call. Count-preserving, so
  // providerMessages.length stays valid for the finished-message merge below.
  const providerMessages = normalizeProviderMessages(fitted.messages);

  // onFinish fires even when the stream ends with an error part, so track
  // overflow within this request — otherwise the finish handler would clear
  // the recovery round the error handler just recorded.
  let overflowNotedThisRequest = false;
  const noteOverflowForSession = () => {
    // The stream layer can surface the same failure more than once; advance
    // the progressive schedule a single step per request.
    if (overflowNotedThisRequest) {
      return;
    }

    overflowNotedThisRequest = true;
    noteContextOverflow(sessionId);
  };

  // Rolling compaction for uncached sessions runs after the turn completes so
  // the summarizer never adds latency to the request path; the next turn picks
  // up the advanced anchor from SessionContextState. Fire-and-forget.
  const maybeRunRollingCompaction = async (finishedMessages: UIMessage[]) => {
    if (cacheActive || !contextConfig.autoCompact) {
      return;
    }
    if (rollingCompactionInFlight.has(sessionId)) {
      return;
    }

    rollingCompactionInFlight.add(sessionId);
    try {
      const latestState = await loadSessionContextStateSafe(sessionId);
      const rollingView = buildProviderView({
        messages: finishedMessages,
        contextState: latestState,
        config: contextConfig,
        modelContextWindow: resolvedProviderModel.contextWindow,
        reservedOutputTokens,
        endpointLimitTokens,
        pendingInteractionCount: await countPendingChatInteractions(sessionId),
        cacheActive,
      });
      if (!rollingView.needsRollingCompaction) {
        return;
      }

      const compaction = await compactSessionContext({
        sessionId,
        coveredMessages: rollingView.coveredMessages,
        previousState: latestState,
        model: resolvedProviderModel.model,
        modelId: chatModelId,
        cwd,
        config: contextConfig,
        estimatedTokens: rollingView.estimate.tokens,
      });
      logger.info("context_rolling_compaction", {
        sessionId,
        tier: compaction.state.tier,
        usedFallback: compaction.usedFallback,
        coveredMessageCount: compaction.state.coveredMessageCount,
      });
    } catch (error) {
      // Best-effort: a failed roll costs nothing — the pressure-driven inline
      // loop and the fit-to-budget clamp still bound the next request.
      logger.error("context_rolling_compaction_failed", {
        sessionId,
        error: getErrorMessage(error),
      });
    } finally {
      rollingCompactionInFlight.delete(sessionId);
    }
  };

  const persistFinishedMessages = async ({
    isAborted,
    isContinuation,
    responseMessage,
    messages,
  }: {
    isAborted: boolean;
    isContinuation: boolean;
    responseMessage: UIMessage;
    messages: UIMessage[];
  }) => {
    if (isAborted) {
      return;
    }

    // The provider accepted the (possibly recovered) view; future overflow
    // episodes start the progressive schedule from the top.
    if (!overflowNotedThisRequest) {
      clearContextOverflowRounds(sessionId);
    }

    const fullHistory = mergeFinishedMessagesIntoFullHistory({
      fullMessages: validatedMessages,
      providerMessageCount: providerMessages.length,
      finishedMessages: messages,
      isContinuation,
      responseMessage,
    });
    const normalizedMessages = removeTrailingEmptyAssistantMessages(fullHistory);
    if (normalizedMessages.length !== fullHistory.length) {
      logger.warn("chat_finish_empty_assistant_skipped", { sessionId });
      return;
    }

    const validatedFinishResult = await safeValidateUIMessages({
      messages: normalizedMessages,
    });
    if (!validatedFinishResult.success) {
      logger.warn("chat_invalid_finish_payload", {
        sessionId,
        message: validatedFinishResult.error.message,
      });
      return;
    }

    try {
      const persistResult = await persistChatMessages({
        sessionId,
        messages: validatedFinishResult.data,
        assistantModel: chatModelId,
        expectedRevision: baseRevision,
        cwd,
        mode,
        permissionMode: permissionMode ?? null,
      });

      if (persistResult.staleSkip) {
        incrementChatFailureCounter("stale_finish_skip", {
          sessionId,
          expectedRevision: baseRevision,
          actualRevision: persistResult.revision,
        });
      }

      logChatWriteEvent({
        sessionId,
        revision: persistResult.revision,
        phase: "finish",
        staleSkip: persistResult.staleSkip,
      });

      maybeScheduleSessionAutoTitle({
        sessionId,
        messages: validatedFinishResult.data,
      });

      if (!persistResult.staleSkip) {
        void maybeRunRollingCompaction(validatedFinishResult.data);
      }
    } catch (error) {
      logger.error("chat_finish_persist_failed", {
        sessionId,
        error: getErrorMessage(error),
      });
    }
  };

  const buildUsageMessageMetadata = ({
    part,
  }: {
    part: TextStreamPart<ToolSet>;
  }) => {
    // The XML tool-call middleware flags tool intent it detected but could
    // not parse; forward it so the client can auto-nudge instead of idling.
    if (part.type === "finish-step") {
      const toolIntent = (
        part.providerMetadata?.lightcode as { toolIntent?: string } | undefined
      )?.toolIntent;
      return toolIntent ? { toolIntent } : undefined;
    }

    if (part.type !== "finish") {
      return undefined;
    }

    return {
      usage: {
        inputTokens: part.totalUsage.inputTokens,
        outputTokens: part.totalUsage.outputTokens,
        totalTokens: part.totalUsage.totalTokens,
        cachedInputTokens: part.totalUsage.cachedInputTokens,
      },
      modelId: chatModelId,
      finishReason: part.finishReason,
      // Server-measured context state so the client meter is authoritative
      // instead of re-deriving from its own (calibration-blind) heuristic.
      context: {
        inputTokens: view.estimate.tokens,
        contextWindow: view.contextWindow,
        compactedMessages: contextState?.coveredMessageCount ?? 0,
      },
    };
  };

  // Snapshot the workspace once per turn so both paths can make the agent
  // aware of the repo it is running in (reads the cwd instead of asking the
  // user to paste code). Best-effort; never throws. Only the session's first
  // turn pays for the full snapshot (listing, project docs, skills);
  // follow-up turns send a compact delta of the parts that drift (git, date).
  const isFirstAssistantTurn = !validatedMessages.some(
    (message) => message.role === "assistant",
  );
  const environmentContext = isFirstAssistantTurn
    ? await buildWorkspaceContext({ cwd })
    : await buildWorkspaceContextDelta({ cwd });
  const availableSkillNames = listSkills({ cwd }).map((skill) => skill.name);

  try {
    if (
      shouldUseFastChatPath({
        messages: providerMessages,
        mode,
        allowedTools,
        availableSkillNames,
      })
    ) {
      logger.info("chat_fast_path", {
        sessionId,
        model: chatModelId,
      });

      const result = streamText({
        model: resolvedProviderModel.model,
        system: `${fastChatSystemPrompt}\n\n${environmentContext}`,
        messages: buildFastChatModelMessages(providerMessages),
        maxOutputTokens: Math.min(
          lightcodeConfigResult.config.maxOutputTokens,
          fastChatMaxOutputTokens,
        ),
        maxRetries: lightcodeConfigResult.config.maxRetries,
        providerOptions: resolvedProviderModel.providerOptions,
        // Stop generating when the client disconnects.
        abortSignal: c.req.raw.signal,
      });

      result.consumeStream({
        onError: (error) => {
          if (isDisconnectOrTimeoutError(error)) {
            incrementChatFailureCounter("timeout_disconnect", {
              sessionId,
              phase: "stream",
            });
            logChatDisconnectEvent({
              sessionId,
              phase: "stream",
              error,
            });
          }
        },
      });

      return withSseHeartbeat(result.toUIMessageStreamResponse({
        originalMessages: providerMessages,
        generateMessageId: generateId,
        sendReasoning: false,
        messageMetadata: buildUsageMessageMetadata,
        onError: (error) => {
          const classified = classifyChatError(error);

          if (classified.kind === "context_overflow") {
            noteLearnedContextLimit(chatModelId, classified.contextLimitTokens);
            noteOverflowForSession();
          }
          incrementChatFailureCounter(
            chatFailureClassForErrorKind(classified.kind),
            { sessionId, statusCode: classified.statusCode },
          );
          logChatStreamErrorEvent({
            sessionId,
            phase: "stream",
            classified,
            error,
          });

          return formatChatStreamError(classified);
        },
        onFinish: persistFinishedMessages,
      }));
    }

    // NOTE: mid-stream provider drops cannot be resumed server-side —
    // createAgentUIStreamResponse has already emitted UI parts, so replaying
    // the step would duplicate part ids. The structured envelope below lets
    // the client decide between a sanitized retry and surfacing the error.
    const mapStreamError = (error: unknown) => {
      const classified = classifyChatError(error);

      if (classified.kind === "context_overflow") {
        noteLearnedContextLimit(chatModelId, classified.contextLimitTokens);
        noteOverflowForSession();
      }
      incrementChatFailureCounter(chatFailureClassForErrorKind(classified.kind), {
        sessionId,
        statusCode: classified.statusCode,
      });
      logChatStreamErrorEvent({
        sessionId,
        phase: "stream",
        classified,
        error,
      });

      return formatChatStreamError(classified);
    };

    return withSseHeartbeat(await createAgentUIStreamResponse({
      agent: codingAgent,
      uiMessages: providerMessages,
      options: {
        cwd,
        sessionId,
        mode,
        permissionMode,
        allowedTools,
        permissionRules,
        sandbox,
        environmentContext,
      },
      // Stop the agent loop (including pending tool turns) on disconnect.
      abortSignal: c.req.raw.signal,
      generateMessageId: generateId,
      sendReasoning: true,
      messageMetadata: buildUsageMessageMetadata,
      consumeSseStream: async ({ stream }) => {
        await consumeStream({
          stream,
          onError: (error) => {
            if (isDisconnectOrTimeoutError(error)) {
              incrementChatFailureCounter("timeout_disconnect", {
                sessionId,
                phase: "stream",
              });
              logChatDisconnectEvent({
                sessionId,
                phase: "stream",
                error,
              });
            }
          },
        });
      },
      onError: mapStreamError,
      onFinish: persistFinishedMessages,
    }));
  } catch (error) {
    const classified = classifyChatError(error);

    if (classified.kind === "context_overflow") {
      noteLearnedContextLimit(chatModelId, classified.contextLimitTokens);
      noteContextOverflow(sessionId);
    }
    incrementChatFailureCounter(chatFailureClassForErrorKind(classified.kind), {
      sessionId,
      phase: "pre-stream",
      statusCode: classified.statusCode,
    });
    logChatStreamErrorEvent({
      sessionId,
      phase: "pre-stream",
      classified,
      error,
    });

    if (classified.kind === "billing") {
      return c.json({ error: providerBillingOrQuotaMessage }, 402);
    }

    if (classified.kind === "network" || classified.kind === "aborted") {
      logChatDisconnectEvent({
        sessionId,
        phase: "pre-stream",
        error,
      });
      return c.json({ error: recoverableDisconnectMessage }, 503);
    }

    return c.json(
      {
        error: formatChatStreamError(classified),
        details: Bun.env.NODE_ENV === "production" ? undefined : getErrorMessage(error),
      },
      500
    );
  }
}
