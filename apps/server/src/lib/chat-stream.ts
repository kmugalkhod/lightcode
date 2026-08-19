import {
  artifactizeLargeToolOutputs,
  buildProviderView,
  collectMessageText,
  createCodingAgentTools,
  computeRecentTurnStartIndex,
  estimateModelMessageTokens,
  estimateStructuralTokens,
  formatChatStreamError,
  lightcodeConfigDefaults,
  listSkills,
  normalizeProviderMessages,
  ProviderTurnAssembler,
  resolveCodingAgentCallSettings,
  resolveContextWindowTokens,
  resolveMaxOutputTokens,
  selectCodingAgentIntentTools,
  type CodingAgentMode,
  type CodingAgentToolName,
  type CodingAgentCallOptions,
  type PermissionMode,
  type PermissionRules,
  type ProviderWebSearchDecision,
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
  type ModelMessage,
  type UIMessage,
} from "ai";
import type { Context } from "hono";
import {
  materializeProviderAttachments,
  storeInlineMessageBlobs,
} from "./attachment-store";
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
  assertSessionWorkspaceIdentity,
  persistChatMessages,
  resolveChatSessionIdentifier,
  SessionNotFoundError,
  SessionWorkspaceIdentityError,
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
  collectRelatedWorkspacePaths,
} from "./workspace-context";
import {
  chatModelId,
  codingAgent,
  lightcodeConfigResult,
  resolvedProviderModel,
} from "./runtime-config";
import {
  providerWebSearchApprovalRequiredBody,
  resolveProviderWebSearchGate,
} from "./provider-web-search-gate";

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
// Upper bound on iterative Tier-2 compaction rounds per turn. The anchor
// advances each round so compaction terminates on its own; this only caps
// worst-case latency from repeated summarizer calls. One round: each
// summarizer call is a blocking LLM request (~30s worst case) paid BEFORE the
// first token streams, so extra rounds read as a stalled agent. Whatever one
// round doesn't cover, the fit-to-budget clamp bounds this request and the
// advanced anchor lets the next turn (or the post-turn rolling pass) continue.
const MAX_COMPACTION_ROUNDS = 1;

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

export function buildFastChatModelMessages(
  messages: UIMessage[],
  preserveRecentTokens: number,
): ModelMessage[] {
  const modelMessages = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role,
      content: collectMessageText(message),
    }))
    .filter((message) => message.content.length > 0) as ModelMessage[];
  const preserveFrom = computeRecentTurnStartIndex(
    modelMessages,
    preserveRecentTokens,
    estimateModelMessageTokens,
  );
  return modelMessages.slice(preserveFrom);
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

export interface StreamSessionChatOptions {
  /**
   * Server-authoritative run cancellation. When supplied, an HTTP client
   * disconnect only detaches that subscriber; this signal is the sole stop.
   */
  abortSignal?: AbortSignal;
  /** Optimistic revision checked before any provider/tool side effect starts. */
  expectedRevision?: number;
  /** One-turn decision collected before exposing provider-executed search. */
  providerWebSearchDecision?: ProviderWebSearchDecision;
}

export async function streamSessionChat(
  c: Context,
  sessionIdentifier: string,
  messagesPayload: SessionMessagesResponse["messages"] | UIMessage[],
  cwd: string,
  mode: CodingAgentMode,
  permissionMode: PermissionMode | undefined,
  allowedTools: CodingAgentToolName[] | undefined,
  permissionRules: PermissionRules | undefined,
  sandbox: SandboxConfig | undefined,
  options: StreamSessionChatOptions = {},
) {
  const requestAbortSignal = options.abortSignal ?? c.req.raw.signal;
  // A request that dies before streaming any part leaves an empty assistant
  // message in the client's history; the SDK schema rejects zero-part
  // messages, which would wedge the session on every subsequent send. Drop
  // them — they carry nothing.
  const messagesPayloadWithoutEmpties = (
    messagesPayload as Array<{ role?: unknown; parts?: unknown }>
  ).filter(
    (message) =>
      !(
        message?.role === "assistant" &&
        Array.isArray(message.parts) &&
        message.parts.length === 0
      ),
  ) as SessionMessagesResponse["messages"];

  const validatedMessagesResult = await safeValidateUIMessages({
    messages: messagesPayloadWithoutEmpties,
  });

  if (!validatedMessagesResult.success) {
    logger.warn("chat_invalid_messages_payload", {
      sessionIdentifier,
      // The SDK error embeds the full payload before the cause; keep the tail
      // (the actual validation issue), not the dump.
      error: validatedMessagesResult.error.message.slice(-1_500),
    });
    return c.json({ error: "Invalid chat messages payload." }, 400);
  }

  // Keep this defensive gate in the execution boundary as well as the routes:
  // provider-native search can execute and bill inside the generation request,
  // so an AI SDK post-tool-call approval is necessarily too late.
  const providerWebSearchGate = resolveProviderWebSearchGate({
    capability: resolvedProviderModel.webSearchCapability,
    providerToolAvailable: Boolean(
      resolvedProviderModel.providerTools?.web_search,
    ),
    requested: selectCodingAgentIntentTools({
      mode,
      prompt: undefined,
      messages: validatedMessagesResult.data,
    }).includes("web_search"),
    mode,
    permissionMode,
    allowedTools,
    permissionRules,
    decision: options.providerWebSearchDecision,
  });
  if (providerWebSearchGate.action === "approval-required") {
    return c.json(providerWebSearchApprovalRequiredBody(), 428);
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

  try {
    const workspace = await assertSessionWorkspaceIdentity(sessionId);
    // The database identity is authoritative even for compatibility callers
    // that still include a cwd argument.
    cwd = workspace.cwd;
  } catch (error) {
    if (error instanceof SessionWorkspaceIdentityError) {
      return c.json(
        { error: error.message, code: error.code },
        error.code === "workspace_unavailable" ? 404 : 409,
      );
    }
    throw error;
  }

  const validatedMessages = await storeInlineMessageBlobs(
    validatedMessagesResult.data,
  );

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
      expectedRevision: options.expectedRevision,
    });
    baseRevision = persistResult.revision;
    if (persistResult.staleSkip) {
      return c.json(
        {
          error: "The session changed before this turn could start.",
          code: "revision_conflict",
          expectedRevision: options.expectedRevision,
          actualRevision: persistResult.revision,
        },
        409,
      );
    }
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

  const providerInputMessages = await materializeProviderAttachments({
    messages: validatedMessages,
    cwd,
  });

  const contextConfig = lightcodeConfigResult.config.context;
  // Prompt caching (direct Anthropic, or OpenRouter Anthropic-family with
  // cache_control set) needs a byte-stable prefix to hit; elsewhere there is
  // nothing to protect, so Tier-1 may prune more aggressively.
  const cacheActive = resolvedProviderModel.supportsPromptCaching;
  // A hard limit learned from a prior overflow on this model, clamping an
  // optimistic catalog window down to the real serving limit.
  const endpointLimitTokens = getLearnedContextLimit(chatModelId);
  const effectiveContextWindow = resolveContextWindowTokens({
    config: contextConfig,
    modelContextWindow: resolvedProviderModel.contextWindow,
    endpointLimitTokens,
  });
  // The provider counts input + output against the same window, so the input
  // budget must subtract what we reserve for output (resolveMaxOutputTokens
  // grants the model's full advertised cap when the user left the default).
  // Cap the reservation at half the effective window: a model whose advertised
  // output cap rivals the endpoint's whole window (minimax-m3: 512K output on
  // a 524K serving limit) would otherwise starve the input budget to nothing.
  const reservedOutputTokens = Math.min(
    resolveMaxOutputTokens(
      lightcodeConfigResult.config.maxOutputTokens,
      lightcodeConfigDefaults.maxOutputTokens,
      resolvedProviderModel.maxCompletionTokens,
    ),
    Math.max(1024, Math.floor(effectiveContextWindow / 2)),
  );

  // Repository instructions are provider-call state, not chat history. Replay
  // the source-hashed baseline on every turn; follow-ups only omit the bulky
  // top-level directory listing. Keeping the baseline first preserves a stable
  // prompt-cache prefix while the git/date delta is allowed to change.
  const isFirstAssistantTurn = !validatedMessages.some(
    (message) => message.role === "assistant",
  );
  const relatedPaths = collectRelatedWorkspacePaths(validatedMessages);
  const environmentContext = isFirstAssistantTurn
    ? await buildWorkspaceContext({ cwd, sessionId, relatedPaths })
    : await buildWorkspaceContextDelta({ cwd, sessionId, relatedPaths });
  const availableSkillNames = listSkills({ cwd }).map((skill) => skill.name);
  const useFastChatPath = shouldUseFastChatPath({
    messages: providerInputMessages,
    mode,
    allowedTools,
    availableSkillNames,
  });
  const agentCallOptions: CodingAgentCallOptions = {
    cwd,
    sessionId,
    mode,
    permissionMode,
    providerWebSearchDecision: options.providerWebSearchDecision,
    allowedTools,
    permissionRules,
    sandbox,
    environmentContext,
    assemblyAbortSignal: requestAbortSignal,
  };
  const agentCallSettings = resolveCodingAgentCallSettings({
    options: agentCallOptions,
    prompt: undefined,
    messages: providerInputMessages,
    promptOverride: Bun.env.LIGHTCODE_CODING_AGENT_SYSTEM_PROMPT,
    includeToolDiscipline:
      resolvedProviderModel.needsToolCallDiscipline ?? false,
    providerWebSearchTool: Boolean(
      resolvedProviderModel.providerTools?.web_search,
    ),
  });
  const fastOutputTokens = Math.min(
    lightcodeConfigResult.config.maxOutputTokens,
    fastChatMaxOutputTokens,
  );
  const requestSystem = useFastChatPath
    ? `${fastChatSystemPrompt}\n\n${environmentContext}`
    : agentCallSettings.instructions;
  const requestTools = useFastChatPath ? undefined : createCodingAgentTools();
  if (requestTools) {
    if (!resolvedProviderModel.webSearchCapability.available) {
      delete requestTools.web_search;
    } else if (
      resolvedProviderModel.providerTools?.web_search &&
      agentCallSettings.providerWebSearchAccess?.action === "expose"
    ) {
      requestTools.web_search = resolvedProviderModel.providerTools.web_search;
    } else if (resolvedProviderModel.providerTools?.web_search) {
      delete requestTools.web_search;
    }
  }
  const requestActiveTools = useFastChatPath
    ? []
    : agentCallSettings.activeTools.filter(
        (toolName) => requestTools?.[toolName] !== undefined,
      );
  const budgetReservedOutputTokens = useFastChatPath
    ? fastOutputTokens
    : reservedOutputTokens;
  const baseTurnAssembler = new ProviderTurnAssembler({
    system: requestSystem,
    tools: requestTools,
    activeTools: requestActiveTools,
    contextWindow: effectiveContextWindow,
    reservedOutputTokens: budgetReservedOutputTokens,
  });
  const turnAssembler = new ProviderTurnAssembler({
    system: requestSystem,
    tools: requestTools,
    activeTools: requestActiveTools,
    contextWindow: effectiveContextWindow,
    reservedOutputTokens: budgetReservedOutputTokens,
    originalInputTokens:
      estimateStructuralTokens(providerInputMessages) +
      baseTurnAssembler.fixedInputTokens,
  });

  const pendingInteractionCount = await countPendingChatInteractions(sessionId);
  let contextState = await loadSessionContextStateSafe(sessionId);
  let view = buildProviderView({
    messages: providerInputMessages,
    contextState,
    config: contextConfig,
    modelContextWindow: resolvedProviderModel.contextWindow,
    reservedOutputTokens: budgetReservedOutputTokens,
    endpointLimitTokens,
    pendingInteractionCount,
    cacheActive,
    fixedInputTokens: turnAssembler.fixedInputTokens,
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
          abortSignal: requestAbortSignal,
          contextWindow: view.contextWindow,
        });
        contextState = compaction.state;
        view = buildProviderView({
          messages: providerInputMessages,
          contextState,
          config: contextConfig,
          modelContextWindow: resolvedProviderModel.contextWindow,
          reservedOutputTokens: budgetReservedOutputTokens,
          endpointLimitTokens,
          pendingInteractionCount,
          cacheActive,
          fixedInputTokens: turnAssembler.fixedInputTokens,
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
        if (requestAbortSignal.aborted) {
          return c.json({ error: recoverableDisconnectMessage }, 503);
        }
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
      preserveRecentTokens: Math.min(
        contextConfig.preserveRecentTokens,
        overflowPreserve * 2_000,
      ),
      preserveRecentMessages: Math.min(
        overflowPreserve,
        contextConfig.preserveRecentMessages,
      ),
    };

    try {
      const overflowView = buildProviderView({
        messages: providerInputMessages,
        contextState,
        config: overflowConfig,
        modelContextWindow: resolvedProviderModel.contextWindow,
        reservedOutputTokens: budgetReservedOutputTokens,
        endpointLimitTokens,
        pendingInteractionCount: 0,
        cacheActive,
        fixedInputTokens: turnAssembler.fixedInputTokens,
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
          abortSignal: requestAbortSignal,
          contextWindow: overflowView.contextWindow,
        });
        contextState = compaction.state;
      }

      view = buildProviderView({
        messages: providerInputMessages,
        contextState,
        config: overflowConfig,
        modelContextWindow: resolvedProviderModel.contextWindow,
        reservedOutputTokens: budgetReservedOutputTokens,
        endpointLimitTokens,
        pendingInteractionCount: 0,
        cacheActive,
        fixedInputTokens: turnAssembler.fixedInputTokens,
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
      if (requestAbortSignal.aborted) {
        return c.json({ error: recoverableDisconnectMessage }, 503);
      }
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
  // Normalize first because synthesizing a terminal result for an interrupted
  // tool call changes the serialized request. The assembler must account for
  // that exact final shape rather than fitting a smaller pre-normalized view.
  const normalizedProviderView = normalizeProviderMessages(
    view.providerMessages,
  );
  const assembledTurn = turnAssembler.assembleUIMessages(
    normalizedProviderView,
    { preserveRecentTokens: view.preserveRecentTokens },
  );
  if (assembledTurn.fit.fitted) {
    logger.warn("context_fit_to_budget", {
      sessionId,
      inputBudgetTokens: assembledTurn.breakdown.inputBudgetTokens,
      contextWindow: view.contextWindow,
      estimatedTokensBefore:
        estimateStructuralTokens(view.providerMessages) +
        turnAssembler.fixedInputTokens,
      estimatedTokensAfter: assembledTurn.breakdown.inputTokens,
      elidedToolOutputs: assembledTurn.fit.elidedToolOutputs,
      droppedMessages: assembledTurn.fit.droppedMessages,
      truncatedTextParts: assembledTurn.fit.truncatedTextParts,
      withinBudget: assembledTurn.withinBudget,
    });
  }

  if (!assembledTurn.withinBudget) {
    return c.json(
      {
        error:
          "The latest user input cannot fit this model's context window without truncation.",
        code: "context_input_too_large",
        context: assembledTurn.breakdown,
      },
      413,
    );
  }

  // This is the exact provider view; its actual length is passed to the
  // finished-message merge so dropped/compacted history remains local-only.
  const providerMessages = assembledTurn.messages;

  // Per-request output ceiling: input + max_tokens share one window, so ask
  // only for what is actually left after the input (with a margin for
  // estimation error). Without this, a large advertised output cap overflows
  // the endpoint's real window as soon as the history grows (HTTP 400
  // "maximum context length is N tokens").
  const requestMaxOutputTokens = useFastChatPath
    ? fastOutputTokens
    : Math.max(
        1024,
        Math.min(
          reservedOutputTokens,
          view.contextWindow - assembledTurn.breakdown.inputTokens - 4096,
        ),
      );

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
        reservedOutputTokens: budgetReservedOutputTokens,
        endpointLimitTokens,
        pendingInteractionCount: await countPendingChatInteractions(sessionId),
        cacheActive,
        fixedInputTokens: turnAssembler.fixedInputTokens,
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
        contextWindow: rollingView.contextWindow,
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

  // `finish.totalUsage` is cumulative billing usage across the tool loop;
  // `finish-step.usage` is the actual final provider context. Keep both rather
  // than driving the context meter from a cumulative number.
  let finalStepInputTokens: number | undefined;

  const buildUsageMessageMetadata = ({
    part,
  }: {
    part: TextStreamPart<ToolSet>;
  }) => {
    // The XML tool-call middleware flags tool intent it detected but could
    // not parse; forward it so the client can auto-nudge instead of idling.
    if (part.type === "finish-step") {
      finalStepInputTokens = part.usage.inputTokens;
      const toolIntent = (
        part.providerMetadata?.lightcode as { toolIntent?: string } | undefined
      )?.toolIntent;
      return toolIntent ? { toolIntent } : undefined;
    }

    if (part.type !== "finish") {
      return undefined;
    }

    const finalContextInputTokens =
      finalStepInputTokens ?? assembledTurn.breakdown.inputTokens;
    const finalMessageTokens = Math.max(
      0,
      finalContextInputTokens -
        assembledTurn.breakdown.systemTokens -
        assembledTurn.breakdown.toolTokens -
        assembledTurn.breakdown.mediaTokens,
    );

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
        inputTokens: finalContextInputTokens,
        contextWindow: view.contextWindow,
        compactedMessages: contextState?.coveredMessageCount ?? 0,
        systemTokens: assembledTurn.breakdown.systemTokens,
        toolTokens: assembledTurn.breakdown.toolTokens,
        messageTokens: finalMessageTokens,
        mediaTokens: assembledTurn.breakdown.mediaTokens,
        remainingTokens: Math.max(
          0,
          view.contextWindow -
            requestMaxOutputTokens -
            finalContextInputTokens,
        ),
        compactedTokens: assembledTurn.breakdown.compactedTokens,
      },
    };
  };

  try {
    if (useFastChatPath) {
      logger.info("chat_fast_path", {
        sessionId,
        model: chatModelId,
      });

      const fastProviderView = await artifactizeLargeToolOutputs(
        buildFastChatModelMessages(
          providerMessages,
          view.preserveRecentTokens,
        ),
        { signal: requestAbortSignal },
      );
      const fastTurn = turnAssembler.assembleModelMessages(
        fastProviderView.messages,
        { preserveRecentTokens: view.preserveRecentTokens },
      );
      if (!fastTurn.withinBudget) {
        return c.json(
          {
            error:
              "The latest user input cannot fit this model's context window without truncation.",
            code: "context_input_too_large",
            context: fastTurn.breakdown,
          },
          413,
        );
      }

      const result = streamText({
        model: resolvedProviderModel.model,
        system: requestSystem,
        messages: fastTurn.messages,
        maxOutputTokens: fastOutputTokens,
        maxRetries: lightcodeConfigResult.config.maxRetries,
        providerOptions: resolvedProviderModel.providerOptions,
        onStepFinish: ({ usage }) => {
          finalStepInputTokens = usage.inputTokens;
        },
        // Stop generating when the client disconnects.
        abortSignal: requestAbortSignal,
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
        providerWebSearchDecision: options.providerWebSearchDecision,
        allowedTools,
        permissionRules,
        sandbox,
        environmentContext,
        maxOutputTokens: requestMaxOutputTokens,
        contextWindow: view.contextWindow,
        preserveRecentTokens: view.preserveRecentTokens,
        originalInputTokens:
          estimateStructuralTokens(providerInputMessages) +
          turnAssembler.fixedInputTokens,
        assemblyAbortSignal: requestAbortSignal,
        // Scope checkpoints and the repeat-call guard to the user turn, so an
        // approval continuation keeps grouping with the turn it belongs to.
        turnKey: [...validatedMessages]
          .reverse()
          .find((message) => message.role === "user")?.id,
      },
      // Only an explicit run abort stops a server-authoritative turn. Legacy
      // /chat calls still use the HTTP request signal above.
      abortSignal: requestAbortSignal,
      generateMessageId: generateId,
      onStepFinish: ({ usage }) => {
        finalStepInputTokens = usage.inputTokens;
      },
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
