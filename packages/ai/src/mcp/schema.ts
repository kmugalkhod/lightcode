import { z } from "zod";
import { mcpResourceSchema, mcpServerStatusSchema } from "./config";

export const listMcpResourcesDescription =
  "List resources exposed by configured MCP servers. Servers must be configured and permission-gated.";

export const readMcpResourceDescription =
  "Read a resource from a configured MCP server by server name and resource URI.";

export const callMcpToolDescription =
  "Call a configured MCP server tool. This is gated as danger-full-access unless explicitly allowed.";

export const listMcpResourcesInputSchema = z.object({
  server: z.string().min(1).max(120).optional(),
});

export const listMcpResourcesProviderInputSchema = z.object({
  server: z.string().min(1).max(120).optional(),
});

export const listMcpResourcesOutputSchema = z.object({
  servers: z.array(mcpServerStatusSchema),
  resources: z.array(mcpResourceSchema),
});

export const readMcpResourceInputSchema = z.object({
  server: z.string().min(1).max(120),
  uri: z.string().min(1).max(4096),
});

export const readMcpResourceProviderInputSchema = readMcpResourceInputSchema;

export const readMcpResourceOutputSchema = z.object({
  server: z.string(),
  uri: z.string(),
  content: z.string(),
  mimeType: z.string().nullable(),
});

export const callMcpToolInputSchema = z.object({
  server: z.string().min(1).max(120),
  toolName: z.string().min(1).max(240),
  arguments: z.record(z.string(), z.unknown()).optional().default({}),
});

export const callMcpToolProviderInputSchema = z.object({
  server: z.string().min(1).max(120),
  toolName: z.string().min(1).max(240),
});

export const callMcpToolOutputSchema = z.object({
  server: z.string(),
  toolName: z.string(),
  result: z.unknown(),
});
