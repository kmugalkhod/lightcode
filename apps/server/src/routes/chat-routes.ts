import { anthropic } from "@ai-sdk/anthropic";
import { zValidator } from "@hono/zod-validator";
import {
  createAgentUIStreamResponse,
  consumeStream,
  generateId,
  safeValidateUIMessages,
  type UIMessage,
} from "ai";
import {
  assertProviderToolSchemaBudget,
  codingChatRequestSchema,
  createCodingAgent,
  type CodingAgentMode,
  type SessionMessagesResponse,
  sessionPathParamsSchema,
} from "@lightcode/ai";
import type { Context } from "hono";
import { Hono } from "hono";
import { createChatSession, loadChatMessages, persistChatMessages } from "../lib/chat-store";
import {
  getErrorMessage,
  isProviderBillingOrQuotaError,
  incrementChatFailureCounter,
  isDisconnectOrTimeoutError,
  isProviderSchemaRejectionError,
  logChatDisconnectEvent,
  logChatWriteEvent,
} from "../lib/chat-observability";

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

assertProviderToolSchemaBudget();

const chatModelId = Bun.env.LIGHTCODE_CHAT_MODEL ?? "claude-haiku-4-5";
const codingAgentPromptOverride = Bun.env.LIGHTCODE_CODING_AGENT_SYSTEM_PROMPT;
const codingAgentProviderOptions =
  chatModelId === "claude-opus-4-7"
    ? {
        anthropic: {
          thinking: {
            type: "adaptive",
            display: "summarized",
          },
          effort: "medium",
        },
      }
    : undefined;

const codingAgent = createCodingAgent({
  model: anthropic(chatModelId),
  promptOverride: codingAgentPromptOverride,
  providerOptions: codingAgentProviderOptions,
  maxSteps: 10,
  maxOutputTokens: 10000,
});

async function streamSessionChat(
  c: Context,
  sessionId: string,
  messagesPayload: SessionMessagesResponse["messages"],
  cwd: string,
  mode: CodingAgentMode,
) {
  const validatedMessagesResult = await safeValidateUIMessages({
    messages: messagesPayload,
  });

  if (!validatedMessagesResult.success) {
    return c.json({ error: "Invalid chat messages payload." }, 400);
  }

  const validatedMessages = validatedMessagesResult.data;
  let baseRevision = 0;

  try {
    const persistResult = await persistChatMessages({
      sessionId,
      messages: validatedMessages,
      assistantModel: chatModelId,
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
      options: { cwd, mode },
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
  .post("/", async (c) => {
    try {
      const session = await createChatSession();
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
  .get("/:id/messages", zValidator("param", sessionPathParamsSchema), async (c) => {
    const { id } = c.req.valid("param");

    try {
      const messages = await loadChatMessages(id);
      return c.json({ messages });
    } catch (error) {
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
  .post(
    "/:id/chat",
    zValidator("param", sessionPathParamsSchema),
    zValidator("json", sessionChatRequestSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      return streamSessionChat(c, id, body.messages, body.cwd, body.mode);
    }
  );
