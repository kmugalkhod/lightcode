import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeCodingTool } from "../runtime-registry";
import { mcpConfigSchema } from "./config";
import { McpServerManager, stopAllMcpServers, summarizeToolParameters } from "./manager";

/**
 * A small stdio MCP server: paginated tools/list, tools that echo, fail, run
 * slowly, ping the client first, or crash the process, plus one resource. It
 * also prints a non-JSON line to stdout, as some real servers do.
 */
const stdioServerSource = String.raw`
const tools = [
  { name: "echo", description: "Echo the text back.\n\nMore detail.", inputSchema: { type: "object", properties: { text: { type: "string" }, times: { type: "number" } }, required: ["text"] } },
  { name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
  { name: "slow", description: "Answers after two seconds.", inputSchema: { type: "object", properties: {} } },
  { name: "ping_first", description: "Pings the client before answering.", inputSchema: { type: "object", properties: {} } },
  { name: "crash", description: "Exits the process.", inputSchema: { type: "object", properties: {} } },
];
let nextServerRequestId = 1000;
const waiting = new Map();
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
console.log("starting test server (not JSON)");
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});
function handle(message) {
  if (message.id !== undefined && message.method === undefined) {
    waiting.get(message.id)?.(message);
    return;
  }
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "test", version: "1" } });
    case "tools/list":
      return message.params && message.params.cursor
        ? reply({ tools: tools.slice(2) })
        : reply({ tools: tools.slice(0, 2), nextCursor: "page-2" });
    case "tools/call": {
      const { name, arguments: args } = message.params;
      if (name === "echo") return reply({ content: [{ type: "text", text: String(args.text).repeat(args.times || 1) }] });
      if (name === "fail") return reply({ content: [{ type: "text", text: "the widget is broken" }], isError: true });
      if (name === "slow") return setTimeout(() => reply({ content: [{ type: "text", text: "late" }] }), 2000);
      if (name === "crash") { process.stderr.write("fatal: crashing on purpose\n"); process.exit(3); }
      if (name === "ping_first") {
        const id = nextServerRequestId++;
        waiting.set(id, (answer) => reply({ content: [{ type: "text", text: "client answered ping: " + JSON.stringify(answer.result) }] }));
        return send({ jsonrpc: "2.0", id, method: "ping" });
      }
      return send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Unknown tool " + name } });
    }
    case "resources/list":
      return reply({ resources: [{ uri: "memo://readme", name: "readme", mimeType: "text/plain" }] });
    case "resources/read":
      return reply({ contents: [{ uri: message.params.uri, mimeType: "text/plain", text: "resource body" }] });
    default:
      if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } });
  }
}
`;

let workspace = "";
let serverScript = "";

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "lightcode-mcp-"));
  serverScript = path.join(workspace, "test-server.js");
  await writeFile(serverScript, stdioServerSource);
});

afterEach(async () => {
  await stopAllMcpServers();
});

afterAll(async () => {
  await stopAllMcpServers();
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
});

function stdioManager(extra: Record<string, unknown> = {}) {
  return new McpServerManager(
    { servers: { test: { command: process.execPath, args: [serverScript], ...extra } } },
    { cwd: workspace },
  );
}

describe("MCP config", () => {
  test("accepts Claude Code's .mcp.json spelling", () => {
    const config = mcpConfigSchema.parse({
      servers: {
        local: { command: "npx", args: ["-y", "server"] },
        remote: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
        streamed: { type: "streamable-http", url: "https://example.com/mcp" },
        legacy: { type: "sse", url: "https://example.com/sse" },
      },
    });
    expect(config.servers.local?.transport).toBe("stdio");
    expect(config.servers.remote?.transport).toBe("http");
    expect(config.servers.streamed?.transport).toBe("http");
    expect(config.servers.legacy?.transport).toBe("sse");
  });

  test("summarizes a tool's parameters compactly", () => {
    expect(
      summarizeToolParameters({
        type: "object",
        properties: { owner: { type: "string" }, labels: { type: "array", items: { type: "string" } }, state: { enum: ["open", "closed"] } },
        required: ["owner"],
      }),
    ).toBe('owner*: string, labels: string[], state: "open"|"closed"');
  });
});

describe("stdio MCP servers", () => {
  test("lists every page of tools and calls one with arguments", async () => {
    const manager = stdioManager();
    const listed = await manager.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["echo", "fail", "slow", "ping_first", "crash"]);
    expect(listed.tools[0]).toMatchObject({ description: "Echo the text back.", parameters: "text*: string, times: number" });
    expect(listed.servers[0]?.state).toBe("running");

    const result = await manager.callTool("test", "echo", { text: "hi ", times: 3 });
    expect(result.content).toBe("hi hi hi ");
  }, 20_000);

  test("one tool's full schema on request", async () => {
    const listed = await stdioManager().listTools({ server: "test", toolName: "echo" });
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0]?.inputSchema).toMatchObject({ required: ["text"] });
    expect(listed.tools[0]?.description).toContain("More detail.");
  }, 20_000);

  test("tool errors, unknown tools, and unknown servers explain themselves", async () => {
    const manager = stdioManager();
    await expect(manager.callTool("test", "fail", {})).rejects.toThrow("the widget is broken");
    await expect(manager.callTool("test", "nope", {})).rejects.toThrow(/has no tool "nope".*echo/);
    await expect(manager.callTool("other", "echo", {})).rejects.toThrow(/not configured.*test/);
  }, 20_000);

  test("answers the server's ping and reads resources", async () => {
    const manager = stdioManager();
    expect((await manager.callTool("test", "ping_first", {})).content).toBe("client answered ping: {}");
    const resources = await manager.listResources();
    expect(resources.resources).toEqual([
      { server: "test", uri: "memo://readme", name: "readme", description: null, mimeType: "text/plain" },
    ]);
    expect((await manager.readResource("test", "memo://readme")).content).toBe("resource body");
  }, 20_000);

  test("a crashed server reports why and reconnects on the next call", async () => {
    const manager = stdioManager();
    await expect(manager.callTool("test", "crash", {})).rejects.toThrow(/exited[\s\S]*crashing on purpose/);
    expect(manager.inspectServer("test")?.state).toBe("degraded");
    expect((await manager.callTool("test", "echo", { text: "back" })).content).toBe("back");
  }, 20_000);

  test("a per-server timeout stops a slow call", async () => {
    const manager = stdioManager({ timeoutMs: 1_000 });
    await expect(manager.callTool("test", "slow", {})).rejects.toThrow(/no answer within 1s/);
    expect((await manager.callTool("test", "echo", { text: "still alive" })).content).toBe("still alive");
  }, 20_000);

  test("a command that cannot start fails with the reason", async () => {
    const manager = new McpServerManager({ servers: { broken: { command: "lightcode-no-such-command-xyz" } } }, { cwd: workspace });
    await expect(manager.listTools({ server: "broken" })).rejects.toThrow(/Could not connect to MCP server "broken"/);
    expect(manager.inspectServer("broken")?.state).toBe("degraded");
  }, 20_000);
});

interface TestMessage {
  id?: number;
  method?: string;
  params?: { name?: string; arguments?: { text?: string } };
}

/** Minimal JSON-RPC answers shared by the HTTP test servers. */
function answer(message: TestMessage) {
  if (message.method === "initialize") {
    return { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } };
  }
  if (message.method === "tools/list") {
    return { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "shout", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } };
  }
  if (message.method === "tools/call") {
    return { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(message.params?.arguments?.text).toUpperCase() }] } };
  }
  return null;
}

describe("remote MCP servers", () => {
  test("streamable HTTP: JSON and SSE replies, with the session id echoed", async () => {
    const seenSessions: Array<string | null> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.method === "DELETE") return new Response(null, { status: 200 });
        const message = (await request.json()) as TestMessage;
        seenSessions.push(request.headers.get("mcp-session-id"));
        if (message.id === undefined) return new Response(null, { status: 202 });
        const body = answer(message);
        if (message.method === "tools/call") {
          // Reply over an event stream, as servers may for any request.
          return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return Response.json(body, { headers: message.method === "initialize" ? { "mcp-session-id": "session-42" } : {} });
      },
    });
    try {
      const manager = new McpServerManager({ servers: { remote: { type: "http", url: `http://127.0.0.1:${server.port}/mcp` } } });
      expect((await manager.listTools()).tools.map((tool) => tool.name)).toEqual(["shout"]);
      expect((await manager.callTool("remote", "shout", { text: "quiet" })).content).toBe("QUIET");
      expect(seenSessions[0]).toBeNull();
      expect(seenSessions.slice(1).every((id) => id === "session-42")).toBe(true);
    } finally {
      await stopAllMcpServers();
      server.stop(true);
    }
  }, 20_000);

  test("legacy HTTP+SSE: replies arrive on the event stream", async () => {
    let push: ((text: string) => void) | null = null;
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/sse") {
          const stream = new ReadableStream<string>({
            start(controller) {
              push = (text) => controller.enqueue(text);
              controller.enqueue("event: endpoint\ndata: /messages?session=1\n\n");
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }
        const message = (await request.json()) as TestMessage;
        const body = answer(message);
        if (body) push?.(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
        return new Response(null, { status: 202 });
      },
    });
    try {
      const manager = new McpServerManager({ servers: { legacy: { type: "sse", url: `http://127.0.0.1:${server.port}/sse` } } });
      expect((await manager.callTool("legacy", "shout", { text: "old school" })).content).toBe("OLD SCHOOL");
    } finally {
      await stopAllMcpServers();
      server.stop(true);
    }
  }, 20_000);
});

describe("MCP tools for the agent", () => {
  test("list_mcp_tools and call_mcp_tool run through the tool runtime", async () => {
    const configPath = path.join(workspace, "user-settings.json");
    await writeFile(configPath, JSON.stringify({ mcp: { servers: { test: { command: process.execPath, args: [serverScript] } } } }));
    const previous = process.env.LIGHTCODE_USER_CONFIG;
    process.env.LIGHTCODE_USER_CONFIG = configPath;
    try {
      const options = { cwd: workspace, mode: "build" as const, permissionMode: "danger-full-access" as const };
      const listed = await executeCodingTool("list_mcp_tools", {}, options);
      expect(listed.tools.map((tool) => tool.name)).toContain("echo");
      const called = await executeCodingTool("call_mcp_tool", { server: "test", toolName: "echo", arguments: { text: "via agent" } }, options);
      expect(called.content).toBe("via agent");
    } finally {
      if (previous === undefined) delete process.env.LIGHTCODE_USER_CONFIG;
      else process.env.LIGHTCODE_USER_CONFIG = previous;
    }
  }, 20_000);

  test("with no servers configured, the listing says how to add one", async () => {
    const configPath = path.join(workspace, "empty-settings.json");
    await writeFile(configPath, "{}");
    const previous = process.env.LIGHTCODE_USER_CONFIG;
    process.env.LIGHTCODE_USER_CONFIG = configPath;
    try {
      const listed = await executeCodingTool("list_mcp_tools", {}, { cwd: workspace, mode: "plan", permissionMode: "read-only" });
      expect(listed.tools).toEqual([]);
      expect(listed.message).toContain("mcp.servers");
    } finally {
      if (previous === undefined) delete process.env.LIGHTCODE_USER_CONFIG;
      else process.env.LIGHTCODE_USER_CONFIG = previous;
    }
  });
});
