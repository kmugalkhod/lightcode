import { zValidator } from "@hono/zod-validator";
import {
  createAgentUIStreamResponse,
  consumeStream,
  generateId,
  safeValidateUIMessages,
  streamText,
  type UIMessage,
} from "ai";
import {
  codingChatRequestSchema,
  chatInteractionListQuerySchema,
  chatInteractionResolveRequestSchema,
  chatInteractionUpsertRequestSchema,
  concreteSessionInteractionPathParamsSchema,
  concreteSessionPathParamsSchema,
  selectCodingAgentIntentTools,
  sessionInteractionPathParamsSchema,
  sessionCreateRequestSchema,
  type CodingAgentToolName,
  type CodingAgentMode,
  type PermissionMode,
  type PermissionRules,
  type SandboxConfig,
  type SessionMessagesResponse,
  sessionPathParamsSchema,
} from "@lightcode/ai";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  createChatSession,
  deleteChatSession,
  exportChatSessionJson,
  listChatSessions,
  loadChatSessionWithMessages,
  persistChatMessages,
  resolveChatSessionIdentifier,
  SessionNotFoundError,
} from "../lib/chat-store";
import {
  ChatInteractionNotFoundError,
  listChatInteractions,
  resolveChatInteraction,
  upsertChatInteraction,
} from "../lib/chat-interaction-store";
import {
  getErrorMessage,
  isProviderBillingOrQuotaError,
  incrementChatFailureCounter,
  isDisconnectOrTimeoutError,
  isProviderSchemaRejectionError,
  logChatDisconnectEvent,
  logChatWriteEvent,
} from "../lib/chat-observability";
import {
  chatModelId,
  codingAgent,
  lightcodeConfigResult,
  resolvedProviderModel,
} from "../lib/runtime-config";

const sessionChatRequestSchema = codingChatRequestSchema;

const recoverableDisconnectMessage = "Connection interrupted. Please retry or regenerate your last message.";
const genericRecoverableMessage = "The response stream was interrupted. Please retry.";
const providerBillingOrQuotaMessage =
  "The configured model provider rejected this request due to billing or quota limits. " +
  "Update provider credits/quota and retry.";

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

function collectMessageText(message: UIMessage) {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((text) => text.trim().length > 0)
    .join("\n")
    .trim();
}

function buildFastChatModelMessages(messages: UIMessage[]) {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role,
      content: collectMessageText(message),
    }))
    .filter((message) => message.content.length > 0)
    .slice(-6);
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

async function streamSessionChat(
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
    console.error("Failed to persist incoming chat messages.", error);
    return c.json(
      {
        error: "Unable to persist incoming chat messages.",
        details: Bun.env.NODE_ENV === "production" ? undefined : getErrorMessage(error),
      },
      500
    );
  }

  try {
    if (
      shouldUseFastChatPath({
        messages: validatedMessages,
        mode,
        allowedTools,
      })
    ) {
      console.log(
        JSON.stringify({
          event: "chat_fast_path",
          sessionId,
          model: chatModelId,
        }),
      );

      const result = streamText({
        model: resolvedProviderModel.model,
        system:
          "You are Lightcode's friendly coding assistant. For casual conversation, reply briefly and naturally. " +
          "If the user asks for coding work, say you can help and ask them what they want to change.",
        messages: buildFastChatModelMessages(validatedMessages),
        maxOutputTokens: Math.min(lightcodeConfigResult.config.maxOutputTokens, 512),
        providerOptions: resolvedProviderModel.providerOptions,
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
        originalMessages: validatedMessages,
        generateMessageId: generateId,
        sendReasoning: false,
        onError: (error) => {
          if (isProviderSchemaRejectionError(error)) {
            incrementChatFailureCounter("provider_schema_rejection", {
              sessionId,
            });
          }

          return genericRecoverableMessage;
        },
        onFinish: async ({ isAborted, messages }) => {
          if (isAborted) {
            return;
          }

          const normalizedMessages = removeTrailingEmptyAssistantMessages(messages);
          if (normalizedMessages.length !== messages.length) {
            console.warn(
              JSON.stringify({
                event: "chat_finish_empty_assistant_skipped",
                sessionId,
              }),
            );
            return;
          }

          const validatedMessagesResult = await safeValidateUIMessages({
            messages: normalizedMessages,
          });
          if (!validatedMessagesResult.success) {
            console.warn(
              JSON.stringify({
                event: "chat_invalid_finish_payload",
                sessionId,
                message: validatedMessagesResult.error.message,
              }),
            );
            return;
          }

          try {
            const persistResult = await persistChatMessages({
              sessionId,
              messages: validatedMessagesResult.data,
              assistantModel: chatModelId,
              expectedRevision: baseRevision,
              cwd,
              mode,
              permissionMode: permissionMode ?? null,
            });

            logChatWriteEvent({
              sessionId,
              revision: persistResult.revision,
              phase: "finish",
              staleSkip: persistResult.staleSkip,
            });
          } catch (error) {
            console.error("Failed to persist fast assistant response message.", {
              sessionId,
              error: getErrorMessage(error),
            });
          }
        },
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
      uiMessages: validatedMessages,
      options: {
        cwd,
        mode,
        permissionMode,
        allowedTools,
        permissionRules,
        sandbox,
      },
      generateMessageId: generateId,
      sendReasoning: true,
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
      onFinish: async ({ isAborted, messages }) => {
        if (isAborted) {
          return;
        }

        const normalizedMessages = removeTrailingEmptyAssistantMessages(messages);
        if (normalizedMessages.length !== messages.length) {
          console.warn(
            JSON.stringify({
              event: "chat_finish_empty_assistant_skipped",
              sessionId,
            })
          );
          return;
        }

        const validatedMessagesResult = await safeValidateUIMessages({ messages: normalizedMessages });
        if (!validatedMessagesResult.success) {
          console.warn(
            JSON.stringify({
              event: "chat_invalid_finish_payload",
              sessionId,
              message: validatedMessagesResult.error.message,
            })
          );
          return;
        }

        try {
          const persistResult = await persistChatMessages({
            sessionId,
            messages: validatedMessagesResult.data,
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
        } catch (error) {
          console.error("Failed to persist assistant response message.", {
            sessionId,
            error: getErrorMessage(error),
          });
        }
      },
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

export const sessionRoutes = new Hono()
  .get("/", async (c) => {
    try {
      const sessions = await listChatSessions();
      return c.json({ sessions });
    } catch (error) {
      console.error("Failed to list chat sessions.", error);
      return c.json(
        {
          error: "Unable to list chat sessions.",
          details: Bun.env.NODE_ENV === "production" ? undefined : getErrorMessage(error),
        },
        500
      );
    }
  })
  .post("/", zValidator("json", sessionCreateRequestSchema), async (c) => {
    const body = c.req.valid("json");

    try {
      const session = await createChatSession({
        cwd: body.cwd,
        mode: body.mode ?? lightcodeConfigResult.config.defaultMode,
        permissionMode:
          body.permissionMode ?? lightcodeConfigResult.config.permissionMode ?? null,
        model: chatModelId,
        title: body.title,
      });
      return c.json(session, 201);
    } catch (error) {
      console.error("Failed to create chat session.", error);
      return c.json(
        {
          error: "Unable to create chat session.",
          details: Bun.env.NODE_ENV === "production" ? undefined : getErrorMessage(error),
        },
        500
      );
    }
  })
  .get("/:id", zValidator("param", sessionPathParamsSchema), async (c) => {
    const { id } = c.req.valid("param");

    try {
      return c.json(await loadChatSessionWithMessages(id));
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return c.json({ error: error.message }, 404);
      }

      console.error("Failed to resume chat session.", error);
      return c.json(
        {
          error: "Unable to resume chat session.",
          details: Bun.env.NODE_ENV === "production" ? undefined : getErrorMessage(error),
        },
        500
      );
    }
  })
  .get("/:id/messages", zValidator("param", sessionPathParamsSchema), async (c) => {
    const { id } = c.req.valid("param");

    try {
      return c.json(await loadChatSessionWithMessages(id));
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return c.json({ error: error.message }, 404);
      }

      console.error("Failed to load persisted chat messages.", error);
      return c.json(
        {
          error: "Unable to load persisted chat messages.",
          details: Bun.env.NODE_ENV === "production" ? undefined : getErrorMessage(error),
        },
        500
      );
    }
  })
  .get(
    "/:id/interactions",
    zValidator("param", sessionInteractionPathParamsSchema),
    zValidator("query", chatInteractionListQuerySchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const query = c.req.valid("query");

      try {
        const sessionId = await resolveChatSessionIdentifier(id);
        return c.json(
          await listChatInteractions({
            sessionId,
            status: query.status,
            kind: query.kind,
          }),
        );
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return c.json({ error: error.message }, 404);
        }

        console.error("Failed to list chat interactions.", error);
        return c.json(
          {
            error: "Unable to list chat interactions.",
            details: Bun.env.NODE_ENV === "production" ? undefined : getErrorMessage(error),
          },
          500
        );
      }
    }
  )
  .post(
    "/:id/interactions",
    zValidator("param", sessionInteractionPathParamsSchema),
    zValidator("json", chatInteractionUpsertRequestSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");

      try {
        const sessionId = await resolveChatSessionIdentifier(id);
        return c.json(await upsertChatInteraction({ sessionId, ...body }), 201);
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return c.json({ error: error.message }, 404);
        }

        console.error("Failed to upsert chat interaction.", error);
        return c.json(
          {
            error: "Unable to checkpoint chat interaction.",
            details: Bun.env.NODE_ENV === "production" ? undefined : getErrorMessage(error),
          },
          500
        );
      }
    }
  )
  .patch(
    "/:id/interactions/:toolCallId",
    zValidator("param", concreteSessionInteractionPathParamsSchema),
    zValidator("json", chatInteractionResolveRequestSchema),
    async (c) => {
      const { id, toolCallId } = c.req.valid("param");
      const body = c.req.valid("json");

      try {
        const sessionId = await resolveChatSessionIdentifier(id);
        return c.json(
          await resolveChatInteraction({
            sessionId,
            toolCallId,
            ...body,
          }),
        );
      } catch (error) {
        if (
          error instanceof SessionNotFoundError ||
          error instanceof ChatInteractionNotFoundError
        ) {
          return c.json({ error: error.message }, 404);
        }

        console.error("Failed to resolve chat interaction.", error);
        return c.json(
          {
            error: "Unable to resolve chat interaction.",
            details: Bun.env.NODE_ENV === "production" ? undefined : getErrorMessage(error),
          },
          500
        );
      }
    }
  )
  .get("/:id/export", zValidator("param", sessionPathParamsSchema), async (c) => {
    const { id } = c.req.valid("param");

    try {
      return c.json(await exportChatSessionJson(id));
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return c.json({ error: error.message }, 404);
      }

      console.error("Failed to export chat session.", error);
      return c.json(
        {
          error: "Unable to export chat session.",
          details: Bun.env.NODE_ENV === "production" ? undefined : getErrorMessage(error),
        },
        500
      );
    }
  })
  .delete("/:id", zValidator("param", concreteSessionPathParamsSchema), async (c) => {
    const { id } = c.req.valid("param");

    try {
      return c.json(await deleteChatSession(id));
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return c.json({ error: error.message }, 404);
      }

      console.error("Failed to delete chat session.", error);
      return c.json(
        {
          error: "Unable to delete chat session.",
          details: Bun.env.NODE_ENV === "production" ? undefined : getErrorMessage(error),
        },
        500
      );
    }
  })
  .post(
    "/:id/chat",
    zValidator("param", sessionPathParamsSchema),
    zValidator("json", sessionChatRequestSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      return streamSessionChat(
        c,
        id,
        body.messages,
        body.cwd,
        body.mode ?? lightcodeConfigResult.config.defaultMode,
        body.permissionMode ?? lightcodeConfigResult.config.permissionMode,
        body.allowedTools ?? lightcodeConfigResult.config.allowedTools,
        body.permissionRules ?? lightcodeConfigResult.config.permissions,
        body.sandbox ?? lightcodeConfigResult.config.sandbox,
      );
    }
  );
