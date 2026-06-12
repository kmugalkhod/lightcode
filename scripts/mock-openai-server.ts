/**
 * Mock OpenAI-compatible provider for reliability testing.
 *
 * Run:  bun scripts/mock-openai-server.ts            (port 8787)
 * Then point Lightcode at it:
 *   { "provider": "openai-compatible",
 *     "baseUrl": "http://127.0.0.1:8787/v1",
 *     "model": "mock-ok" }
 *
 * Behavior is selected by model name:
 *   mock-ok          stream a normal short completion
 *   mock-slow-20s    20s of silence before the first token (stall/heartbeat test)
 *   mock-400         reject with a non-retryable invalid_request error
 *   mock-overflow    reject with a context-window error until the request
 *                    body shrinks below ~8 KB (progressive compaction test)
 *   mock-429-once    429 on the first request, then stream normally
 *   mock-500-twice   500 on the first two requests, then stream normally
 *   mock-drop        emit half a completion then kill the connection
 */

const port = Number(process.env.MOCK_PORT ?? 8787);

const attemptCounters = new Map<string, number>();

function countAttempt(key: string): number {
  const next = (attemptCounters.get(key) ?? 0) + 1;
  attemptCounters.set(key, next);
  return next;
}

function sseChunk(payload: Record<string, unknown>) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function completionChunk(model: string, delta: Record<string, unknown>, finishReason: string | null = null) {
  return sseChunk({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

function errorResponse(status: number, message: string, type = "invalid_request_error") {
  return new Response(
    JSON.stringify({ error: { message, type, code: null } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function streamCompletion({
  model,
  firstTokenDelayMs = 0,
  dropMidStream = false,
}: {
  model: string;
  firstTokenDelayMs?: number;
  dropMidStream?: boolean;
}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (firstTokenDelayMs > 0) {
        await Bun.sleep(firstTokenDelayMs);
      }

      controller.enqueue(encoder.encode(completionChunk(model, { role: "assistant" })));
      controller.enqueue(
        encoder.encode(completionChunk(model, { content: "Hello from the mock provider. " })),
      );

      if (dropMidStream) {
        // Simulate a connection reset mid-response.
        controller.error(new Error("connection dropped"));
        return;
      }

      controller.enqueue(
        encoder.encode(completionChunk(model, { content: "All systems nominal." })),
      );
      controller.enqueue(encoder.encode(completionChunk(model, {}, "stop")));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  // The slow-model knob intentionally sits silent past Bun's 10s default.
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/models")) {
      return Response.json({ data: [{ id: "mock-ok" }] });
    }

    if (!url.pathname.endsWith("/chat/completions")) {
      return new Response("not found", { status: 404 });
    }

    const bodyText = await request.text();
    const body = JSON.parse(bodyText) as { model?: string };
    const model = body.model ?? "mock-ok";
    console.log(
      `[mock] ${model} request, body ${bodyText.length} bytes, attempt ${countAttempt(model)}`,
    );

    switch (model) {
      case "mock-400":
        return errorResponse(
          400,
          "messages.2: `tool_use` ids must have a corresponding `tool_result` block",
        );

      case "mock-overflow":
        if (bodyText.length > 8_000) {
          return errorResponse(
            400,
            "This model's maximum context length is 1000 tokens, your request used more.",
          );
        }
        return streamCompletion({ model });

      case "mock-429-once":
        if ((attemptCounters.get(model) ?? 0) <= 1) {
          return errorResponse(429, "Rate limit exceeded, retry shortly.", "rate_limit_error");
        }
        return streamCompletion({ model });

      case "mock-500-twice":
        if ((attemptCounters.get(model) ?? 0) <= 2) {
          return errorResponse(500, "Upstream provider exploded.", "server_error");
        }
        return streamCompletion({ model });

      case "mock-slow-20s":
        return streamCompletion({ model, firstTokenDelayMs: 20_000 });

      case "mock-drop":
        return streamCompletion({ model, dropMidStream: true });

      default:
        return streamCompletion({ model });
    }
  },
});

console.log(`Mock OpenAI-compatible provider listening on http://127.0.0.1:${port}/v1`);
