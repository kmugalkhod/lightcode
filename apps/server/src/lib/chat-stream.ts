import {
  buildProviderView,
  collectMessageText,
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
  safeValidateUIMessages,
  streamText,
  type TextStreamPart,
  type ToolSet,
  type UIMessage,
} from "ai";
import type { Context } from "hono";
import {
  incrementChatFailureCounter,
  isDisconnectOrTimeoutError,
  isProviderBillingOrQuotaError,
  isProviderSchemaRejectionError,
  logChatDisconnectEvent,
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
import { getSessionContextState } from "./context-state-store";
import { maybeScheduleSessionAutoTitle } from "./session-auto-title";
import {
  chatModelId,
  codingAgent,
  lightcodeConfigResult,
  resolvedProviderModel,
} from "./runtime-config";

const logger = createLogger("chat-stream");

const recoverableDisconnectMessage =
  "Connection interrupted. Please retry or regenerate your last message.";
const genericRecoverableMessage = "The response stream was interrupted. Please retry.";
const providerBillingOrQuotaMessage =
  "The configured model provider rejected this request due to billing or quota limits. " +
  "Update provider credits/quota and retry.";

const fastChatSystemPrompt =
  "You are Lightcode's friendly coding assistant. For casual conversation, reply briefly and naturally. " +
  "If the user asks for coding work, say you can help and ask them what they want to change.";
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

function shouldUseFastChatPath({
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
  const pendingInteractionCount = await countPendingChatInteractions(sessionId);
  let contextState = await loadSessionContextStateSafe(sessionId);
  let view = buildProviderView({
    messages: validatedMessages,
    contextState,
    config: contextConfig,
    modelContextWindow: resolvedProviderModel.contextWindow,
    pendingInteractionCount,
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

  const providerMessages = view.providerMessages;

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
        system: fastChatSystemPrompt,
        messages: buildFastChatModelMessages(providerMessages),
        maxOutputTokens: Math.min(
          lightcodeConfigResult.config.maxOutputTokens,
          fastChatMaxOutputTokens,
        ),
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

      return result.toUIMessageStreamResponse({
        originalMessages: providerMessages,
        generateMessageId: generateId,
        sendReasoning: false,
        messageMetadata: buildUsageMessageMetadata,
        onError: (error) => {
          if (isProviderSchemaRejectionError(error)) {
            incrementChatFailureCounter("provider_schema_rejection", {
              sessionId,
            });
          }

          return genericRecoverableMessage;
        },
        onFinish: persistFinishedMessages,
      });
    }

    const mapStreamError = (error: unknown) => {
      if (isProviderSchemaRejectionError(error)) {
        incrementChatFailureCounter("provider_schema_rejection", {
          sessionId,
        });
        return genericRecoverableMessage;
      }

      if (isProviderBillingOrQuotaError(error)) {
        incrementChatFailureCounter("provider_billing_quota", {
          sessionId,
        });
        return providerBillingOrQuotaMessage;
      }

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
        return recoverableDisconnectMessage;
      }

      return genericRecoverableMessage;
    };

    return await createAgentUIStreamResponse({
      agent: codingAgent,
      uiMessages: providerMessages,
      options: {
        cwd,
        mode,
        permissionMode,
        allowedTools,
        permissionRules,
        sandbox,
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
    });
  } catch (error) {
    if (isProviderSchemaRejectionError(error)) {
      incrementChatFailureCounter("provider_schema_rejection", {
        sessionId,
      });
    }

    if (isProviderBillingOrQuotaError(error)) {
      incrementChatFailureCounter("provider_billing_quota", {
        sessionId,
      });
      return c.json({ error: providerBillingOrQuotaMessage }, 402);
    }

    if (isDisconnectOrTimeoutError(error)) {
      incrementChatFailureCounter("timeout_disconnect", {
        sessionId,
        phase: "pre-stream",
      });
      logChatDisconnectEvent({
        sessionId,
        phase: "pre-stream",
        error,
      });
      return c.json({ error: recoverableDisconnectMessage }, 503);
    }

    return c.json(
      {
        error: "Unable to start chat stream.",
        details: Bun.env.NODE_ENV === "production" ? undefined : getErrorMessage(error),
      },
      500
    );
  }
}
