import { describe, expect, test } from "bun:test";
import { withSseHeartbeat } from "./sse-heartbeat";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function createControlledResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  return {
    response: new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    }),
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

async function readAll(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  let output = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return output;
    }
    output += decoder.decode(value, { stream: true });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withSseHeartbeat", () => {
  test("injects heartbeat comments during silence at event boundaries", async () => {
    const { response, push, close } = createControlledResponse();
    const heartbeated = withSseHeartbeat(response, 40);
    const result = readAll(heartbeated);

    push('data: {"type":"text-delta"}\n\n');
    await sleep(120);
    push('data: {"type":"finish"}\n\n');
    close();

    const output = await result;
    expect(output).toContain(": heartbeat\n\n");
    expect(output.indexOf(": heartbeat")).toBeGreaterThan(
      output.indexOf("text-delta"),
    );
    expect(output.indexOf(": heartbeat")).toBeLessThan(
      output.indexOf("finish"),
    );
  });

  test("never injects a heartbeat mid-event", async () => {
    const { response, push, close } = createControlledResponse();
    const heartbeated = withSseHeartbeat(response, 40);
    const result = readAll(heartbeated);

    // A chunk that stops mid-event: no trailing blank line.
    push('data: {"type":"text-del');
    await sleep(120);
    push('ta"}\n\n');
    close();

    const output = await result;
    expect(output).not.toContain("heartbeat");
    expect(output).toContain('data: {"type":"text-delta"}\n\n');
  });

  test("passes data through unchanged when there is no silence", async () => {
    const { response, push, close } = createControlledResponse();
    const heartbeated = withSseHeartbeat(response, 5_000);
    const result = readAll(heartbeated);

    push("data: one\n\n");
    push("data: two\n\n");
    close();

    expect(await result).toBe("data: one\n\ndata: two\n\n");
  });
});
