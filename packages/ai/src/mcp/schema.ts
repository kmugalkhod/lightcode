import { z } from "zod";
import { mcpResourceSchema, mcpServerStatusSchema } from "./config";

export const listMcpToolsDescription =
  "List the tools offered by the configured MCP (Model Context Protocol) servers, with each tool's parameters (* = required). " +
  "Pass server to list one server, and server plus toolName to get that tool's full input schema. Call a tool with call_mcp_tool.";

export const listMcpResourcesDescription =
  "List the resources (documents, files, data) exposed by the configured MCP servers. Read one with read_mcp_resource.";

export const readMcpResourceDescription =
  "Read a resource from a configured MCP server by server name and resource URI (as listed by list_mcp_resources).";

export const callMcpToolDescription =
  "Call a tool on a configured MCP server: server and toolName as listed by list_mcp_tools, and arguments as an object matching that tool's parameters. Calls may require approval.";

const serverNameSchema = z.string().trim().min(1).max(120);

export const listMcpToolsInputSchema = z.object({
  server: serverNameSchema.optional(),
  toolName: z.string().trim().min(1).max(240).optional(),
});

export const listMcpToolsProviderInputSchema = listMcpToolsInputSchema;

export const mcpToolSummarySchema = z.object({
  server: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** Compact signature, e.g. `owner*: string, labels: string[]`. */
  parameters: z.string(),
  /** Full JSON schema, only when one tool was asked for. */
  inputSchema: z.unknown().optional(),
});

export const listMcpToolsOutputSchema = z.object({
  servers: z.array(mcpServerStatusSchema),
  tools: z.array(mcpToolSummarySchema),
  message: z.string().optional(),
});

export const listMcpResourcesInputSchema = z.object({
  server: serverNameSchema.optional(),
});

export const listMcpResourcesProviderInputSchema = listMcpResourcesInputSchema;

export const listMcpResourcesOutputSchema = z.object({
  servers: z.array(mcpServerStatusSchema),
  resources: z.array(mcpResourceSchema),
  message: z.string().optional(),
});

export const readMcpResourceInputSchema = z.object({
  server: serverNameSchema,
  uri: z.string().min(1).max(4096),
});

export const readMcpResourceProviderInputSchema = readMcpResourceInputSchema;

export const readMcpResourceOutputSchema = z.object({
  server: z.string(),
  uri: z.string(),
  content: z.string(),
  mimeType: z.string().nullable(),
  truncated: z.boolean(),
});

export const callMcpToolInputSchema = z.object({
  server: serverNameSchema,
  toolName: z.string().trim().min(1).max(240),
  arguments: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * Sent without strict mode (see the registry): strict grammars cannot express
 * a free-form arguments object, and without it no MCP tool could get input.
 */
export const callMcpToolProviderInputSchema = z.object({
  server: serverNameSchema,
  toolName: z.string().trim().min(1).max(240),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

export const callMcpToolOutputSchema = z.object({
  server: z.string(),
  toolName: z.string(),
  content: z.string(),
  truncated: z.boolean(),
});

export type McpToolSummary = z.infer<typeof mcpToolSummarySchema>;
