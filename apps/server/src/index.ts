import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { anthropic } from "@ai-sdk/anthropic";
import {
  convertToModelMessages,
  safeValidateUIMessages,
  streamText,
} from "ai";
import { z } from "zod";
import { createGreeting, productName } from "@lightcode/shared";

const llmRequestSchema = z.object({
  messages: z.unknown(),
});

export const app = new Hono()
  .get("/", (c) => {
    return c.json({
      name: productName,
      message: createGreeting("API client"),
    });
  })
  .get("/health", (c) => {
    return c.json({ ok: true });
  })
  .get("/llm", (c) => {
    const result = streamText({
      model: anthropic("claude-opus-4-7"),
      prompt: "Tell me a story",
      maxOutputTokens: 300,
    });

    return result.toTextStreamResponse();
  })
  .post("/llm", zValidator("json", llmRequestSchema), async (c) => {
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
      messages: modelMessages,
      maxOutputTokens: 300,
    });

    return result.toUIMessageStreamResponse();
  });

if (import.meta.main) {
  const port = Number(Bun.env.PORT ?? 3000);

  Bun.serve({
    port,
    fetch: app.fetch,
  });

  console.log(`Server listening on http://localhost:${port}`);
}

export type AppType = typeof app;
