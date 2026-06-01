import { z } from "zod";

export const pluginHookEventSchema = z.enum([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
]);

export const pluginHookResultSchema = z.enum(["allow", "deny", "ask"]);

export const pluginHookSchema = z.object({
  event: pluginHookEventSchema,
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).optional().default([]),
  timeoutMs: z.number().int().min(100).max(30_000).optional().default(5_000),
});

export const pluginManifestSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  version: z.string().min(1).max(80).optional(),
  description: z.string().max(1000).optional(),
  enabled: z.boolean().optional().default(true),
  tools: z.array(z.string().min(1).max(120)).optional().default([]),
  hooks: z.array(pluginHookSchema).optional().default([]),
});

export const pluginSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string().nullable(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  path: z.string(),
  hookCount: z.number().int().nonnegative(),
});

export type PluginHookEvent = z.infer<typeof pluginHookEventSchema>;
export type PluginHookResult = z.infer<typeof pluginHookResultSchema>;
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginSummary = z.infer<typeof pluginSummarySchema>;
