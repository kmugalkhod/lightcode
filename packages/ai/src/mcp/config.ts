import { z } from "zod";

export const mcpStdioServerConfigSchema = z.object({
  transport: z.literal("stdio").default("stdio"),
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).optional().default([]),
  cwd: z.string().min(1).max(4096).optional(),
  env: z.record(z.string(), z.string()).optional().default({}),
  enabled: z.boolean().optional().default(true),
});

export const mcpConfigSchema = z.object({
  servers: z.record(z.string().min(1).max(120), mcpStdioServerConfigSchema)
    .optional()
    .default({}),
});

export const mcpServerStateSchema = z.enum([
  "stopped",
  "running",
  "degraded",
]);

export const mcpServerStatusSchema = z.object({
  name: z.string().min(1),
  transport: z.literal("stdio"),
  enabled: z.boolean(),
  state: mcpServerStateSchema,
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
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>;
export type McpResource = z.infer<typeof mcpResourceSchema>;
