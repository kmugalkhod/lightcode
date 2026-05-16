import { anthropic } from "@ai-sdk/anthropic";
import { zValidator } from "@hono/zod-validator";
import {
  consumeStream,
  convertToModelMessages,
  generateId,
  safeValidateUIMessages,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { createChatSession, loadChatMessages, persistChatMessages } from "../lib/chat-store";

const sessionPathParamsSchema = z.object({
  id: z.string().min(1),
});

const legacySessionPathParamsSchema = z.object({
  sessionId: z.string().min(1),
});

const sessionChatRequestSchema = z.object({
  messages: z.unknown(),
});

const legacyChatRequestSchema = sessionChatRequestSchema.extend({
  sessionId: z.string().min(1),
});

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}

const chatTools = {
  getWeather: tool({
    description:
      "Get mock weather for a city. Use this when the user asks about weather or temperature.",
    inputSchema: z.object({
      city: z
        .string()
        .min(1)
        .describe("City name from the user request. Use 'San Francisco' if missing."),
    }),
    execute: async ({ city }): Promise<{ city: string; condition: string; temperatureC: number }> => {
      const normalizedCity = city.trim() || "San Francisco";
      const conditions = ["sunny", "cloudy", "rainy", "windy"] as const;
      const hash = Array.from(normalizedCity).reduce((acc, char) => acc + char.charCodeAt(0), 0);
      const condition = conditions[hash % conditions.length];
      const temperatureC = 16 + (hash % 13);

      return {
        city: normalizedCity,
        condition,
        temperatureC,
      };
    },
  }),
};

const chatModelId = "claude-opus-4-7";

async function streamSessionChat(c: Context, sessionId: string, messagesPayload: unknown) {
  const validatedMessagesResult = await safeValidateUIMessages({
    messages: messagesPayload,
  });

  if (!validatedMessagesResult.success) {
    return c.json({ error: "Invalid chat messages payload." }, 400);
  }

  const validatedMessages = validatedMessagesResult.data;

  try {
    await persistChatMessages({
      sessionId,
      messages: validatedMessages,
      assistantModel: chatModelId,
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

  const modelMessages = await convertToModelMessages(validatedMessages);

  const result = streamText({
    model: anthropic(chatModelId),
    system:
      "You are a helpful assistant. " +
      "If the user asks about weather, temperature, or forecast, call getWeather and answer with city, condition, and temperature. " +
      "For other requests, answer normally without tools.",
    messages: modelMessages,
    tools: chatTools,
    stopWhen: stepCountIs(3),
    providerOptions: {
      anthropic: {
        thinking: { type: "adaptive", display: "summarized" },
      },
    },
    maxOutputTokens: 10000,
  });

  return result.toUIMessageStreamResponse({
    originalMessages: validatedMessages,
    generateMessageId: generateId,
    consumeSseStream: async ({ stream }) => {
      await consumeStream({ stream });
    },
    sendReasoning: true,
    onFinish: async ({ isAborted, messages }) => {
      if (isAborted) {
        return;
      }

      try {
        await persistChatMessages({
          sessionId,
          messages,
          assistantModel: chatModelId,
        });
      } catch (error) {
        console.error("Failed to persist assistant response message.", error);
      }
    },
  });
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
      return streamSessionChat(c, id, body.messages);
    }
  );

export const chatRoutes = new Hono()
  .get("/:sessionId", zValidator("param", legacySessionPathParamsSchema), async (c) => {
    const { sessionId } = c.req.valid("param");

    try {
      const messages = await loadChatMessages(sessionId);
      return c.json({ sessionId, messages });
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
  .post("/", zValidator("json", legacyChatRequestSchema), async (c) => {
    const body = c.req.valid("json");
    return streamSessionChat(c, body.sessionId, body.messages);
  });
