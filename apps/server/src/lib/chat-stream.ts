import {
  buildProviderView,
  collectMessageText,
  formatChatStreamError,
  normalizeProviderMessages,
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
import { withSseHeartbeat } from "./sse-heartbeat";
import { getSessionContextState } from "./context-state-store";
import { maybeScheduleSessionAutoTitle } from "./session-auto-title";
import { buildWorkspaceContext } from "./workspace-context";
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
}: {
  messages: UIMessage[];
  mode: CodingAgentMode;
  allowedTools: CodingAgentToolName[] | undefined;
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
  // Only Anthropic benefits from prompt caching; elsewhere (OpenRouter, generic
  // OpenAI-compatible) there is no byte-stable prefix to protect, so Tier-1 may
  // prune more aggressively.
  const cacheActive = resolvedProviderModel.provider === "anthropic";
  const pendingInteractionCount = await countPendingChatInteractions(sessionId);
  let contextState = await loadSessionContextStateSafe(sessionId);
  let view = buildProviderView({
    messages: validatedMessages,
    contextState,
    config: contextConfig,
    modelContextWindow: resolvedProviderModel.contextWindow,
    pendingInteractionCount,
    cacheActive,
  });

  if (view.needsCompaction && contextConfig.autoCompact) {
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
        pendingInteractionCount,
        cacheActive,
      });
      logger.info("context_auto_compacted", {
        sessionId,
        tier: compaction.state.tier,
        usedFallback: compaction.usedFallback,
        coveredMessageCount: compaction.state.coveredMessageCount,
        estimatedTokensBefore,
        estimatedTokensAfter: view.estimate.tokens,
      });
    } catch (error) {
      // Compaction failures must never block the chat; stream uncompacted.
      logger.error("context_compaction_failed", {
        sessionId,
        error: getErrorMessage(error),
      });
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

  // Final payload guard: whatever path built the view (compaction, tier1
  // prune, overflow recovery, raw history), never hand the provider a dangling
  // tool call. Count-preserving, so providerMessages.length stays valid for
  // the finished-message merge below.
  const providerMessages = normalizeProviderMessages(view.providerMessages);

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
      },
      modelId: chatModelId,
      finishReason: part.finishReason,
    };
  };

  // Snapshot the workspace once per turn so both paths can make the agent
  // aware of the repo it is running in (reads the cwd instead of asking the
  // user to paste code). Best-effort; never throws.
  const environmentContext = await buildWorkspaceContext({ cwd });

  try {
    if (
      shouldUseFastChatPath({
        messages: providerMessages,
        mode,
        allowedTools,
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
