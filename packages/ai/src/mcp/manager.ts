import { z } from "zod";
import { truncateText } from "../common/output-utils";
import {
  McpClient,
  McpRequestError,
  MCP_METHOD_NOT_FOUND,
  createMcpTransport,
} from "./client";
import {
  mcpConfigSchema,
  type McpConfig,
  type McpResource,
  type McpServerConfig,
  type McpServerStatus,
} from "./config";
import type { McpToolSummary } from "./schema";

/** First connection may download the server (`npx -y …`), so allow a while. */
const connectTimeoutMs = 60_000;
const defaultRequestTimeoutMs = 120_000;
const listTimeoutMs = 30_000;
const maxListPages = 20;
/** MCP results beyond this are cut before they reach the model. */
export const MAX_MCP_CONTENT_CHARS = 60_000;

const toolListSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      inputSchema: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  nextCursor: z.string().optional(),
});

const callToolResultSchema = z.object({
  content: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});

const resourceListSchema = z.object({
  resources: z.array(
    z.object({
      uri: z.string().min(1),
      name: z.string().optional(),
      description: z.string().optional(),
      mimeType: z.string().optional(),
    }),
  ),
  nextCursor: z.string().optional(),
});

const readResourceResultSchema = z.object({
  contents: z.array(
    z.object({
      uri: z.string().optional(),
      mimeType: z.string().optional(),
      text: z.string().optional(),
      blob: z.string().optional(),
    }),
  ),
});

interface McpToolInfo {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
}

interface Connection {
  name: string;
  config: McpServerConfig;
  client: McpClient | null;
  connecting: Promise<McpClient> | null;
  error: string | null;
  tools: McpToolInfo[] | null;
}

/**
 * Live connections, shared by every manager: a server keeps running across
 * turns and sessions and is stopped when Lightcode's server exits. Keyed by
 * name and config (and, for stdio, the directory it runs in) so a changed
 * definition starts a fresh connection.
 */
const connections = new Map<string, Connection>();
let exitHandlerInstalled = false;

function installExitHandler() {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.once("exit", () => {
    for (const connection of connections.values()) connection.client?.closeSync();
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMethodNotFound(error: unknown) {
  return error instanceof McpRequestError && error.code === MCP_METHOD_NOT_FOUND;
}

function firstSentence(text: string | undefined, limit = 200): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  const paragraph = trimmed.split(/\n\s*\n/)[0]!.replace(/\s+/g, " ");
  return paragraph.length > limit ? `${paragraph.slice(0, limit - 1)}…` : paragraph;
}

function describeType(schema: unknown): string {
  if (typeof schema !== "object" || schema === null) return "any";
  const record = schema as Record<string, unknown>;
  if (Array.isArray(record.enum)) {
    return record.enum.slice(0, 6).map((value) => JSON.stringify(value)).join("|");
  }
  const type = Array.isArray(record.type) ? record.type.join("|") : record.type;
  if (type === "array") return `${describeType(record.items)}[]`;
  if (typeof type === "string") return type;
  if (Array.isArray(record.anyOf) || Array.isArray(record.oneOf)) return "any";
  return "object";
}

/** `owner*: string, labels: string[]` from a tool's JSON schema. */
export function summarizeToolParameters(inputSchema: Record<string, unknown>, limit = 300): string {
  const properties = inputSchema.properties;
  if (typeof properties !== "object" || properties === null) return "(no parameters)";
  const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);
  const entries = Object.entries(properties as Record<string, unknown>);
  if (entries.length === 0) return "(no parameters)";
  const summary = entries
    .map(([name, schema]) => `${name}${required.has(name) ? "*" : ""}: ${describeType(schema)}`)
    .join(", ");
  return summary.length > limit ? `${summary.slice(0, limit - 1)}…` : summary;
}

/** Text for the model from an MCP content list; binary parts become short notes. */
export function formatMcpContent(content: readonly Record<string, unknown>[], structuredContent?: unknown): string {
  const parts: string[] = [];
  for (const item of content) {
    const type = item.type;
    if (type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (type === "image" || type === "audio") {
      const size = typeof item.data === "string" ? Math.round((item.data.length * 3) / 4 / 1024) : 0;
      parts.push(`[${type} ${typeof item.mimeType === "string" ? item.mimeType : ""}, ${size} KB — not shown]`);
    } else if (type === "resource" && typeof item.resource === "object" && item.resource !== null) {
      const resource = item.resource as Record<string, unknown>;
      parts.push(
        typeof resource.text === "string"
          ? resource.text
          : `[binary resource ${String(resource.uri ?? "")}${typeof resource.mimeType === "string" ? ` (${resource.mimeType})` : ""}]`,
      );
    } else if (type === "resource_link") {
      parts.push(`[resource ${String(item.name ?? "")} ${String(item.uri ?? "")}]`.replace(/\s+\]/, "]"));
    } else {
      parts.push(JSON.stringify(item));
    }
  }
  if (parts.length === 0 && structuredContent !== undefined) {
    parts.push(JSON.stringify(structuredContent, null, 2));
  }
  return parts.join("\n\n");
}

export class McpServerManager {
  private readonly config: McpConfig;

  /**
   * `cwd` is the directory stdio servers without their own `cwd` run in —
   * the workspace, so project-aware servers see the right files.
   */
  constructor(
    config: unknown,
    private readonly options: { cwd?: string } = {},
  ) {
    this.config = mcpConfigSchema.parse(config ?? {});
  }

  /** Enabled server names, in config order. */
  enabledServerNames(): string[] {
    return Object.entries(this.config.servers)
      .filter(([, server]) => server.enabled)
      .map(([name]) => name);
  }

  private connectionKey(name: string, config: McpServerConfig) {
    return JSON.stringify([name, config, config.transport === "stdio" ? (config.cwd ?? this.options.cwd ?? null) : null]);
  }

  private existingConnection(name: string): Connection | undefined {
    const config = this.config.servers[name];
    return config ? connections.get(this.connectionKey(name, config)) : undefined;
  }

  private connection(name: string): Connection {
    const config = this.config.servers[name];
    if (!config) {
      const names = Object.keys(this.config.servers);
      throw new Error(
        `MCP server "${name}" is not configured.` +
          (names.length > 0 ? ` Configured servers: ${names.join(", ")}.` : " No MCP servers are configured."),
      );
    }
    if (!config.enabled) {
      throw new Error(`MCP server "${name}" is disabled in settings.`);
    }
    const key = this.connectionKey(name, config);
    let connection = connections.get(key);
    if (!connection) {
      connection = { name, config, client: null, connecting: null, error: null, tools: null };
      connections.set(key, connection);
    }
    return connection;
  }

  private connect(name: string): Promise<McpClient> {
    const connection = this.connection(name);
    if (connection.client && !connection.client.closed) {
      return Promise.resolve(connection.client);
    }
    if (connection.connecting) return connection.connecting;

    installExitHandler();
    const client = new McpClient(
      createMcpTransport(connection.config, this.options.cwd),
      `MCP server "${name}"`,
    );
    client.onToolsChanged = () => {
      connection.tools = null;
    };
    client.onClosed = (error) => {
      if (connection.client !== client) return;
      connection.client = null;
      connection.tools = null;
      connection.error = error.message;
    };

    connection.connecting = (async () => {
      try {
        await client.connect(connectTimeoutMs);
        connection.client = client;
        connection.error = null;
        return client;
      } catch (error) {
        const diagnostics = client.diagnostics();
        await client.close().catch(() => undefined);
        connection.error = `${errorText(error)}${diagnostics && !errorText(error).includes(diagnostics) ? ` — ${diagnostics.slice(-600)}` : ""}`;
        throw new Error(`Could not connect to MCP server "${name}": ${connection.error}`);
      } finally {
        connection.connecting = null;
      }
    })();
    return connection.connecting;
  }

  private requestTimeoutMs(name: string) {
    return this.config.servers[name]?.timeoutMs ?? defaultRequestTimeoutMs;
  }

  listServers(): McpServerStatus[] {
    return Object.entries(this.config.servers).map(([name, server]) => {
      const connection = this.existingConnection(name);
      const connected = Boolean(connection?.client && !connection.client.closed);
      return {
        name,
        transport: server.transport,
        enabled: server.enabled,
        state: connected ? "running" : connection?.error ? "degraded" : "stopped",
        command: server.transport === "stdio" ? [server.command, ...server.args].join(" ") : server.url,
        pid: connected ? (connection?.client?.pid ?? null) : null,
        error: connected ? null : (connection?.error ?? null),
      };
    });
  }

  inspectServer(name: string): McpServerStatus | null {
    return this.listServers().find((server) => server.name === name) ?? null;
  }

  /** Connects (if needed); a failure is reported in the returned status. */
  async startServer(name: string): Promise<McpServerStatus | null> {
    await this.connect(name).catch(() => undefined);
    return this.inspectServer(name);
  }

  async stopServer(name: string): Promise<McpServerStatus | null> {
    const connection = this.existingConnection(name);
    if (connection?.client) {
      const client = connection.client;
      connection.client = null;
      connection.tools = null;
      connection.error = null;
      await client.close();
    }
    return this.inspectServer(name);
  }

  private targetServers(serverName?: string): string[] {
    if (serverName) {
      this.connection(serverName);
      return [serverName];
    }
    return this.enabledServerNames();
  }

  private async serverTools(name: string, signal?: AbortSignal): Promise<McpToolInfo[]> {
    const connection = this.connection(name);
    const client = await this.connect(name);
    if (connection.tools) return connection.tools;

    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    try {
      for (let page = 0; page < maxListPages; page += 1) {
        const result = toolListSchema.parse(
          await client.request("tools/list", cursor ? { cursor } : {}, { timeoutMs: listTimeoutMs, signal }),
        );
        for (const tool of result.tools) {
          tools.push({ name: tool.name, description: tool.description?.trim() || null, inputSchema: tool.inputSchema ?? {} });
        }
        cursor = result.nextCursor;
        if (!cursor) break;
      }
    } catch (error) {
      if (!isMethodNotFound(error)) throw error;
    }
    connection.tools = tools;
    return tools;
  }

  /** Every listed server is tried; one that fails is reported in `servers`. */
  async listTools({
    server,
    toolName,
    signal,
  }: { server?: string; toolName?: string; signal?: AbortSignal } = {}): Promise<{
    servers: McpServerStatus[];
    tools: McpToolSummary[];
  }> {
    const names = this.targetServers(server);
    const perServer = await Promise.all(
      names.map(async (name) => {
        try {
          return (await this.serverTools(name, signal)).map((tool) => ({ server: name, tool }));
        } catch (error) {
          if (server) throw error;
          return [];
        }
      }),
    );
    let found = perServer.flat();
    if (toolName) {
      found = found.filter(({ tool }) => tool.name === toolName);
      if (found.length === 0) {
        const available = perServer.flat().map(({ tool }) => tool.name);
        throw new Error(
          `No MCP tool "${toolName}"${server ? ` on server "${server}"` : ""}.` +
            (available.length > 0 ? ` Available: ${available.slice(0, 40).join(", ")}.` : ""),
        );
      }
    }
    return {
      servers: this.listServers().filter((status) => names.includes(status.name)),
      tools: found.map(({ server: serverName, tool }) => ({
        server: serverName,
        name: tool.name,
        description: toolName ? tool.description : firstSentence(tool.description ?? undefined),
        parameters: summarizeToolParameters(tool.inputSchema),
        ...(toolName ? { inputSchema: tool.inputSchema } : {}),
      })),
    };
  }

  async callTool(
    server: string,
    toolName: string,
    args: Record<string, unknown>,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<{ server: string; toolName: string; content: string; truncated: boolean }> {
    const client = await this.connect(server);
    const tools = await this.serverTools(server, signal).catch(() => null);
    if (tools && tools.length > 0 && !tools.some((tool) => tool.name === toolName)) {
      throw new Error(
        `MCP server "${server}" has no tool "${toolName}". Its tools: ${tools.slice(0, 40).map((tool) => tool.name).join(", ")}.`,
      );
    }

    const result = callToolResultSchema.parse(
      await client.request(
        "tools/call",
        { name: toolName, arguments: args },
        { timeoutMs: this.requestTimeoutMs(server), signal },
      ),
    );
    const text = formatMcpContent(result.content, result.structuredContent);
    if (result.isError) {
      throw new Error(`MCP tool ${server}/${toolName} reported an error: ${text || "(no details)"}`);
    }
    const truncated = truncateText(text, MAX_MCP_CONTENT_CHARS);
    return { server, toolName, content: truncated.text, truncated: truncated.truncated };
  }

  async listResources(
    serverName?: string,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<{ servers: McpServerStatus[]; resources: McpResource[] }> {
    const names = this.targetServers(serverName);
    const perServer = await Promise.all(
      names.map(async (name): Promise<McpResource[]> => {
        try {
          const client = await this.connect(name);
          if (!client.capabilities.resources) return [];
          const resources: McpResource[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < maxListPages; page += 1) {
            const result = resourceListSchema.parse(
              await client.request("resources/list", cursor ? { cursor } : {}, { timeoutMs: listTimeoutMs, signal }),
            );
            for (const resource of result.resources) {
              resources.push({
                server: name,
                uri: resource.uri,
                name: resource.name ?? null,
                description: firstSentence(resource.description),
                mimeType: resource.mimeType ?? null,
              });
            }
            cursor = result.nextCursor;
            if (!cursor) break;
          }
          return resources;
        } catch (error) {
          if (isMethodNotFound(error)) return [];
          if (serverName) throw error;
          return [];
        }
      }),
    );
    return {
      servers: this.listServers().filter((status) => names.includes(status.name)),
      resources: perServer.flat(),
    };
  }

  async readResource(
    server: string,
    uri: string,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<{ server: string; uri: string; content: string; mimeType: string | null; truncated: boolean }> {
    const client = await this.connect(server);
    const result = readResourceResultSchema.parse(
      await client.request("resources/read", { uri }, { timeoutMs: this.requestTimeoutMs(server), signal }),
    );
    const text = result.contents
      .map((item) =>
        item.text ??
        `[binary content${item.mimeType ? ` (${item.mimeType})` : ""}, ${Math.round(((item.blob?.length ?? 0) * 3) / 4 / 1024)} KB — not shown]`,
      )
      .join("\n\n");
    const truncated = truncateText(text, MAX_MCP_CONTENT_CHARS);
    return {
      server,
      uri,
      content: truncated.text,
      mimeType: result.contents[0]?.mimeType ?? null,
      truncated: truncated.truncated,
    };
  }
}

/** Closes every MCP connection; for tests and shutdown paths. */
export async function stopAllMcpServers(): Promise<void> {
  const open = [...connections.values()];
  connections.clear();
  await Promise.all(
    open.map(async (connection) => {
      const client = connection.client ?? (await connection.connecting?.catch(() => null)) ?? null;
      await client?.close().catch(() => undefined);
    }),
  );
}
