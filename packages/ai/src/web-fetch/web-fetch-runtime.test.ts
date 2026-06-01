import { afterEach, describe, expect, test } from "bun:test";
import { executeCodingTool } from "../runtime-registry";

const servers: Array<{ stop: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
});

describe("web_fetch runtime", () => {
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
