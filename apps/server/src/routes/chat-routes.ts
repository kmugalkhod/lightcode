import { anthropic } from "@ai-sdk/anthropic";
import { zValidator } from "@hono/zod-validator";
import {
  convertToModelMessages,
  safeValidateUIMessages,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { Hono } from "hono";
import { z } from "zod";

const chatRequestSchema = z.object({
  messages: z.unknown(),
});

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

export const chatRoutes = new Hono().post(
  "/",
  zValidator("json", chatRequestSchema),
  async (c) => {
    const body = c.req.valid("json");
    const validatedMessagesResult = await safeValidateUIMessages({
      messages: body.messages,
    });

    if (!validatedMessagesResult.success) {
      return c.json({ error: "Invalid chat messages payload." }, 400);
    }

    const validatedMessages = validatedMessagesResult.data;
    const modelMessages = await convertToModelMessages(validatedMessages);

    const result = streamText({
      model: anthropic("claude-opus-4-7"),
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
      maxOutputTokens: 180,
    });

    return result.toUIMessageStreamResponse({
      sendReasoning: true,
    });
  }
);
