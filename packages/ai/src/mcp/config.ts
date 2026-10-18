import { z } from "zod";

const enabledSchema = z.boolean().optional().default(true);
/** Per-request timeout for the server's tool calls and reads. */
const timeoutMsSchema = z.number().int().min(1_000).max(600_000).optional();

export const mcpStdioServerConfigSchema = z.object({
  transport: z.literal("stdio").default("stdio"),
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).optional().default([]),
  cwd: z.string().min(1).max(4096).optional(),
  env: z.record(z.string(), z.string()).optional().default({}),
  enabled: enabledSchema,
  timeoutMs: timeoutMsSchema,
});

/** Streamable HTTP (`http`) or the older HTTP+SSE transport (`sse`). */
export const mcpRemoteServerConfigSchema = z.object({
  transport: z.enum(["http", "sse"]),
  url: z.string().url().max(4096),
  headers: z.record(z.string(), z.string()).optional().default({}),
  enabled: enabledSchema,
  timeoutMs: timeoutMsSchema,
});

const transportAliases: Record<string, string> = {
  "streamable-http": "http",
  streamableHttp: "http",
  "streamable_http": "http",
};

/**
 * Accepts Claude Code's `.mcp.json` spelling too: `type` for the transport and
 * `streamable-http` for `http`. A server without a transport is stdio.
 */
export const mcpServerConfigSchema = z.preprocess((raw) => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  const { type, ...rest } = record;
  const transport = rest.transport ?? type;
  if (typeof transport !== "string") return rest;
  return { ...rest, transport: transportAliases[transport] ?? transport };
}, z.union([mcpRemoteServerConfigSchema, mcpStdioServerConfigSchema]));

export const mcpConfigSchema = z.object({
  servers: z.record(z.string().min(1).max(120), mcpServerConfigSchema)
    .optional()
    .default({}),
});

export const mcpTransportSchema = z.enum(["stdio", "http", "sse"]);

export const mcpServerStateSchema = z.enum([
  "stopped",
  "running",
  "degraded",
]);

export const mcpServerStatusSchema = z.object({
  name: z.string().min(1),
  transport: mcpTransportSchema,
  enabled: z.boolean(),
  state: mcpServerStateSchema,
  /** The stdio command, or the URL of a remote server. */
  command: z.string().min(1),
  pid: z.number().int().positive().nullable(),
  error: z.string().nullable(),
});

export const mcpResourceSchema = z.object({
  server: z.string().min(1),
  uri: z.string().min(1),
  name: z.string().nullable(),
  description: z.string().nullable(),
  mimeType: z.string().nullable(),
});

export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpStdioServerConfig = z.infer<typeof mcpStdioServerConfigSchema>;
export type McpRemoteServerConfig = z.infer<typeof mcpRemoteServerConfigSchema>;
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>;
export type McpResource = z.infer<typeof mcpResourceSchema>;
