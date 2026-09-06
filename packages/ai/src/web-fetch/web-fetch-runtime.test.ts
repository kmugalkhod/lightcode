import { afterEach, describe, expect, test } from "bun:test";
import { executeCodingTool } from "../runtime-registry";
import { executeWebFetch } from "./runtime";

const servers: Array<{ stop: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
});

describe("web_fetch runtime", () => {
  test("cancels oversized downloads before reading an unbounded body", async () => {
    let cancelled = false;
    let chunks = 0;
    const output = await executeWebFetch({ url: "https://example.test", maxChars: 500 }, { fetch: (async () => new Response(new ReadableStream({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(512 * 1024).fill(65)); },
      cancel() { cancelled = true; },
    }))) as unknown as typeof fetch });
    expect(output.ok).toBe(true);
    expect(output.truncated).toBe(true);
    expect(cancelled).toBe(true);
    expect(chunks).toBeLessThanOrEqual(5);
    expect(output.text.length).toBeLessThanOrEqual(500);
  });

  test("invalid HTML entity code points do not discard the whole page", async () => {
    const output = await executeWebFetch({ url: "https://example.test" }, { fetch: (async () => new Response("<p>Useful text &#99999999; &#xFFFFFF;</p>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch });
    expect(output.ok).toBe(true);
    expect(output.text).toContain("Useful text");
  });
  test("fetches and normalizes bounded HTML text", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          "<html><head><title>Demo</title></head><body><h1>Hello</h1><p>Lightcode&nbsp;web fetch</p></body></html>",
          {
            headers: {
              "content-type": "text/html",
            },
          },
        );
      },
    });
    servers.push(server);

    const output = await executeCodingTool(
      "web_fetch",
      {
        url: server.url.toString(),
        maxChars: 500,
        timeoutMs: 10000,
      },
      {
        cwd: process.cwd(),
        mode: "build",
        permissionMode: "danger-full-access",
      },
    );

    expect(output.ok).toBe(true);
    expect(output.title).toBe("Demo");
    expect(output.text).toContain("Hello");
    expect(output.text).toContain("Lightcode web fetch");
  });
});
