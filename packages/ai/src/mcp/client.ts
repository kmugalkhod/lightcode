import { spawn, type ChildProcess } from "node:child_process";
import { lightcodeVersion } from "@lightcode/shared";
import { z } from "zod";
import { killProcessTree } from "../bash/process";
import type {
  McpRemoteServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
} from "./config";

/** Newest protocol revision Lightcode speaks; servers may answer with an older one. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

const diagnosticsLimitChars = 4_000;

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface TransportHandlers {
  onMessage: (message: JsonRpcMessage) => void;
  onClose: (error: Error) => void;
}

export interface McpTransport {
  start(handlers: TransportHandlers): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
  /** For process-exit handlers, where nothing asynchronous runs. */
  closeSync?(): void;
  /** Sent on later HTTP requests once initialize has negotiated it. */
  setProtocolVersion?(version: string): void;
  readonly pid: number | null;
  /** Recent stderr or HTTP failure text, for error messages. */
  diagnostics(): string;
}

/** Expands `${VAR}` and `${VAR:-default}` the way Claude Code's .mcp.json does. */
export function expandEnvVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback: string | undefined) => env[name] ?? fallback ?? "",
  );
}

function expandRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, expandEnvVars(value)]),
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > diagnosticsLimitChars ? next.slice(-diagnosticsLimitChars) : next;
}

/** Newline-delimited JSON-RPC over a child process's stdin/stdout. */
class StdioTransport implements McpTransport {
  private child: ChildProcess | null = null;
  private stderrTail = "";
  private closing = false;

  constructor(
    private readonly config: McpStdioServerConfig,
    private readonly defaultCwd: string | undefined,
  ) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  diagnostics(): string {
    return this.stderrTail.trim();
  }

  start({ onMessage, onClose }: TransportHandlers): Promise<void> {
    const command = expandEnvVars(this.config.command);
    return new Promise((resolve, reject) => {
      let started = false;
      const child = spawn(command, this.config.args.map((arg) => expandEnvVars(arg)), {
        cwd: this.config.cwd ? expandEnvVars(this.config.cwd) : this.defaultCwd,
        env: { ...process.env, ...expandRecord(this.config.env) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // Own process group on POSIX, so closing reaches what the server started.
        detached: process.platform !== "win32",
      });
      this.child = child;
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");

      let buffered = "";
      child.stdout?.on("data", (chunk: string) => {
        buffered += chunk;
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line) {
            try {
              onMessage(JSON.parse(line) as JsonRpcMessage);
            } catch {
              // Some servers log to stdout; keep it for diagnostics.
              this.stderrTail = appendTail(this.stderrTail, `${line}\n`);
            }
          }
          newline = buffered.indexOf("\n");
        }
      });
      child.stderr?.on("data", (chunk: string) => {
        this.stderrTail = appendTail(this.stderrTail, chunk);
      });
      child.stdin?.on("error", () => {
        // A write to an exited server; the exit handler reports it.
      });
      child.once("spawn", () => {
        started = true;
        resolve();
      });
      child.once("error", (error) => {
        const failure = new Error(`could not start "${command}": ${error.message}`);
        if (!started) reject(failure);
        else onClose(failure);
      });
      child.once("exit", (code, signal) => {
        if (this.closing) return;
        const diagnostics = this.diagnostics();
        onClose(
          new Error(
            `the server process exited (${signal ?? `code ${code}`})${diagnostics ? `: ${diagnostics.slice(-1_000)}` : ""}`,
          ),
        );
      });
    });
  }

  send(message: JsonRpcMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      return Promise.reject(new Error("the server process is not running"));
    }
    return new Promise((resolve, reject) => {
      stdin.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    const child = this.child;
    if (!child) return;
    child.stdin?.end();
    killProcessTree(child);
  }

  closeSync(): void {
    this.closing = true;
    if (this.child) killProcessTree(this.child, { sync: true });
  }
}

interface SseEvent {
  event: string;
  data: string;
}

/** Parses a text/event-stream body, calling `onEvent` for each event with data. */
async function readSseEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    // A trailing \r may be half of a \r\n split across chunks; keep it for now.
    buffered = (buffered + decoder.decode(value, { stream: true })).replace(/\r\n|\r(?!$)/g, "\n");
    let boundary = buffered.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const fieldValue = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = fieldValue;
        else if (field === "data") data.push(fieldValue);
      }
      if (data.length > 0) onEvent({ event, data: data.join("\n") });
      boundary = buffered.indexOf("\n\n");
    }
  }
}

function deliverJson(text: string, onMessage: (message: JsonRpcMessage) => void) {
  if (!text.trim()) return;
  const parsed: unknown = JSON.parse(text);
  for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
    onMessage(message as JsonRpcMessage);
  }
}

/** Streamable HTTP: each message is a POST; replies come back as JSON or SSE. */
class StreamableHttpTransport implements McpTransport {
  readonly pid = null;
  private handlers: TransportHandlers | null = null;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private lastError = "";
  private readonly controller = new AbortController();

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {}

  diagnostics(): string {
    return this.lastError;
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  async start(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers;
  }

  private requestHeaders(): Record<string, string> {
    return {
      ...this.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...(this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {}),
    };
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const handlers = this.handlers;
    if (!handlers) throw new Error("transport is not started");
    const response = await fetch(this.url, {
      method: "POST",
      headers: this.requestHeaders(),
      body: JSON.stringify(message),
      signal: this.controller.signal,
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;

    if (response.status === 202 || response.status === 204) {
      await response.body?.cancel();
      return;
    }
    if (!response.ok) {
      const text = (await response.text().catch(() => "")).trim().slice(0, 500);
      this.lastError = `HTTP ${response.status}${text ? `: ${text}` : ""}`;
      if (response.status === 404 && this.sessionId) {
        // The server dropped our session; reconnecting starts a new one.
        handlers.onClose(new Error(`the server ended the session (${this.lastError})`));
      }
      throw new Error(`${this.url} answered ${this.lastError}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream") && response.body) {
      await readSseEvents(response.body, (event) => deliverJson(event.data, handlers.onMessage));
      return;
    }
    deliverJson(await response.text(), handlers.onMessage);
  }

  async close(): Promise<void> {
    if (this.sessionId) {
      await fetch(this.url, {
        method: "DELETE",
        headers: this.requestHeaders(),
        signal: AbortSignal.timeout(2_000),
      }).catch(() => undefined);
    }
    this.controller.abort();
  }
}

/** The 2024-11-05 transport: a GET event stream plus POSTs to the endpoint it names. */
class LegacySseTransport implements McpTransport {
  readonly pid = null;
  private endpoint: string | null = null;
  private lastError = "";
  private readonly controller = new AbortController();

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {}

  diagnostics(): string {
    return this.lastError;
  }

  async start({ onMessage, onClose }: TransportHandlers): Promise<void> {
    const response = await fetch(this.url, {
      headers: { ...this.headers, accept: "text/event-stream" },
      signal: this.controller.signal,
    });
    if (!response.ok || !response.body) {
      this.lastError = `HTTP ${response.status}`;
      throw new Error(`${this.url} answered ${this.lastError}`);
    }

    await new Promise<void>((resolve, reject) => {
      let haveEndpoint = false;
      readSseEvents(response.body!, (event) => {
        if (event.event === "endpoint") {
          this.endpoint = new URL(event.data.trim(), this.url).toString();
          haveEndpoint = true;
          resolve();
        } else if (event.event === "message") {
          try {
            deliverJson(event.data, onMessage);
          } catch {
            // Ignore events that are not JSON-RPC.
          }
        }
      })
        .then(() => {
          const error = new Error("the server closed its event stream");
          if (haveEndpoint) onClose(error);
          else reject(error);
        })
        .catch((error: unknown) => {
          if (haveEndpoint) onClose(asError(error));
          else reject(asError(error));
        });
    });
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.endpoint) throw new Error("the server has not named its message endpoint");
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { ...this.headers, "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: this.controller.signal,
    });
    await response.body?.cancel();
    if (!response.ok) {
      this.lastError = `HTTP ${response.status}`;
      throw new Error(`${this.endpoint} answered ${this.lastError}`);
    }
  }

  async close(): Promise<void> {
    this.controller.abort();
  }
}

export function createMcpTransport(config: McpServerConfig, defaultCwd?: string): McpTransport {
  if (config.transport === "stdio") {
    return new StdioTransport(config, defaultCwd);
  }
  const remote: McpRemoteServerConfig = config;
  const url = expandEnvVars(remote.url);
  const headers = expandRecord(remote.headers);
  return remote.transport === "sse"
    ? new LegacySseTransport(url, headers)
    : new StreamableHttpTransport(url, headers);
}

const initializeResultSchema = z.object({
  protocolVersion: z.string().optional(),
  capabilities: z.record(z.string(), z.unknown()).optional().default({}),
  serverInfo: z.object({ name: z.string().optional(), version: z.string().optional() }).optional(),
  instructions: z.string().optional(),
});

export class McpRequestError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "McpRequestError";
  }
}

/** JSON-RPC "method not found": the server does not offer that feature. */
export const MCP_METHOD_NOT_FOUND = -32601;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** One initialized MCP session over any transport. */
export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closedError: Error | null = null;
  capabilities: Record<string, unknown> = {};
  instructions: string | undefined;
  onToolsChanged: (() => void) | null = null;
  onClosed: ((error: Error) => void) | null = null;

  constructor(
    private readonly transport: McpTransport,
    private readonly label: string,
  ) {}

  get closed(): boolean {
    return this.closedError !== null;
  }

  get pid(): number | null {
    return this.transport.pid;
  }

  diagnostics(): string {
    return this.transport.diagnostics();
  }

  async connect(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([
        this.transport.start({
          onMessage: (message) => this.handleMessage(message),
          onClose: (error) => this.handleClose(error),
        }),
        timeout,
      ]);
      const result = initializeResultSchema.parse(
        await this.request(
          "initialize",
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "lightcode", version: lightcodeVersion },
          },
          { timeoutMs },
        ),
      );
      this.capabilities = result.capabilities;
      this.instructions = result.instructions;
      this.transport.setProtocolVersion?.(result.protocolVersion ?? MCP_PROTOCOL_VERSION);
      await this.notify("notifications/initialized");
    } finally {
      clearTimeout(timer);
    }
  }

  request(
    method: string,
    params: unknown,
    { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    signal?.throwIfAborted();
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const timer = setTimeout(() => {
        finish();
        this.cancelRequest(id, "timed out");
        reject(new Error(`${this.label}: ${method} got no answer within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      const onAbort = () => {
        finish();
        this.cancelRequest(id, "cancelled");
        reject(asError(signal?.reason ?? new Error("cancelled")));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, {
        resolve: (value) => {
          finish();
          resolve(value);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      });
      this.transport
        .send({ jsonrpc: "2.0", id, method, params })
        .catch((error: unknown) => this.pending.get(id)?.reject(asError(error)));
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.transport.send({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  private cancelRequest(id: number, reason: string) {
    void this.notify("notifications/cancelled", { requestId: id, reason }).catch(() => undefined);
  }

  private reply(message: JsonRpcMessage) {
    void this.transport.send(message).catch(() => undefined);
  }

  private handleMessage(message: JsonRpcMessage) {
    if (typeof message !== "object" || message === null) return;
    const hasId = message.id !== undefined && message.id !== null;

    if (hasId && message.method === undefined) {
      const entry = this.pending.get(Number(message.id));
      if (!entry) return;
      if (message.error) {
        entry.reject(
          new McpRequestError(`${this.label}: ${message.error.message}`, message.error.code),
        );
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if (hasId && message.method) {
      // Requests from the server. Lightcode declares no client capabilities,
      // so only ping is answered.
      this.reply(
        message.method === "ping"
          ? { jsonrpc: "2.0", id: message.id, result: {} }
          : {
              jsonrpc: "2.0",
              id: message.id,
              error: { code: MCP_METHOD_NOT_FOUND, message: `Lightcode does not support ${message.method}` },
            },
      );
      return;
    }

    if (message.method === "notifications/tools/list_changed") {
      this.onToolsChanged?.();
    }
  }

  private handleClose(error: Error) {
    if (this.closedError) return;
    this.closedError = error;
    for (const entry of [...this.pending.values()]) {
      entry.reject(new Error(`${this.label}: ${error.message}`));
    }
    this.onClosed?.(error);
  }

  async close(): Promise<void> {
    this.handleClose(new Error("the connection was closed"));
    await this.transport.close();
  }

  closeSync(): void {
    this.handleClose(new Error("the connection was closed"));
    this.transport.closeSync?.();
  }
}
