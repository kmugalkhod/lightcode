import { z } from "zod";
import {
  codingAgentModeSchema,
  codingAgentToolNameSchema,
} from "./coding-agent-modes";
import {
  lightcodeConfigStatusSchema,
} from "./config/lightcode-config";
import {
  permissionModeSchema,
  permissionRulesSchema,
} from "./permissions";
import { sandboxRuntimeStatusSchema } from "./sandbox/config";
import { sessionSummarySchema } from "./chat-schemas";
import { chatInteractionPendingSummarySchema } from "./chat-interaction-schemas";
import { mcpServerStatusSchema } from "./mcp/config";
import { resolvedWebSearchCapabilitySchema } from "./web-search/config";

export const diagnosticStatusSchema = z.enum(["ok", "warn", "error"]);
export type DiagnosticStatus = z.infer<typeof diagnosticStatusSchema>;

export const diagnosticCheckSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: diagnosticStatusSchema,
  summary: z.string().min(1),
  details: z.array(z.string()).default([]),
});
export type DiagnosticCheck = z.infer<typeof diagnosticCheckSchema>;

export const diagnosticsDatabaseSchema = z.object({
  status: diagnosticStatusSchema,
  reachable: z.boolean(),
  sessionCount: z.number().int().nonnegative().nullable(),
  messageCount: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
});
export type DiagnosticsDatabase = z.infer<typeof diagnosticsDatabaseSchema>;

export const diagnosticsProviderSchema = z.object({
  status: diagnosticStatusSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  configuredModel: z.string().nullable(),
  baseUrlConfigured: z.boolean(),
  missingCredentialHints: z.array(z.string()),
});
export type DiagnosticsProvider = z.infer<typeof diagnosticsProviderSchema>;

export const diagnosticsToolSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  readOnly: z.number().int().nonnegative(),
  workspaceWrite: z.number().int().nonnegative(),
  dangerFullAccess: z.number().int().nonnegative(),
  providerSchemaStatus: diagnosticStatusSchema,
  optionalParameterBudget: z.number().int().positive(),
});
export type DiagnosticsToolSummary = z.infer<typeof diagnosticsToolSummarySchema>;

export const diagnosticsToolSchema = z.object({
  name: codingAgentToolNameSchema,
  description: z.string().min(1),
  permissionMode: permissionModeSchema,
  permissionSubject: codingAgentToolNameSchema,
  activeInModes: z.array(codingAgentModeSchema),
  availability: z.enum([
    "always",
    "model",
    "git-workspace",
    "skills",
    "mcp",
    "web",
  ]),
  execution: z.enum(["server", "client", "server-or-provider"]),
  activation: z.enum(["core", "specialized"]),
  outputPolicy: z.enum(["inline", "artifact-if-large"]),
  providerOptionalPropertyCount: z.number().int().nonnegative(),
  providerSchemaStatus: diagnosticStatusSchema,
});
export type DiagnosticsTool = z.infer<typeof diagnosticsToolSchema>;

export const diagnosticsStatusResponseSchema = z.object({
  generatedAt: z.string().min(1),
  server: z.object({
    status: diagnosticStatusSchema,
    name: z.string().min(1),
    uptimeSeconds: z.number().nonnegative(),
    cwd: z.string().min(1),
    platform: z.string().min(1),
    bunVersion: z.string().nullable(),
  }),
  provider: diagnosticsProviderSchema,
  database: diagnosticsDatabaseSchema,
  config: lightcodeConfigStatusSchema,
  sessions: z.object({
    latest: sessionSummarySchema.nullable(),
  }),
  tools: diagnosticsToolSummarySchema,
  webSearch: resolvedWebSearchCapabilitySchema,
  extensions: z.object({
    skills: z.object({
      count: z.number().int().nonnegative(),
    }),
    mcp: z.object({
      configuredServers: z.number().int().nonnegative(),
      runningServers: z.number().int().nonnegative(),
      degradedServers: z.number().int().nonnegative(),
      servers: z.array(mcpServerStatusSchema),
    }),
    plugins: z.object({
      count: z.number().int().nonnegative(),
      enabled: z.number().int().nonnegative(),
      hooks: z.number().int().nonnegative(),
    }),
  }),
  features: z.object({
    sessions: z.boolean(),
    slashCommands: z.boolean(),
    permissions: z.boolean(),
    sandbox: z.boolean(),
    webTools: z.boolean(),
    skills: z.boolean(),
    mcp: z.boolean(),
    plugins: z.boolean(),
  }),
});
export type DiagnosticsStatusResponse = z.infer<
  typeof diagnosticsStatusResponseSchema
>;

export const diagnosticsDoctorResponseSchema = z.object({
  generatedAt: z.string().min(1),
  status: diagnosticStatusSchema,
  checks: z.array(diagnosticCheckSchema),
});
export type DiagnosticsDoctorResponse = z.infer<
  typeof diagnosticsDoctorResponseSchema
>;

export const diagnosticsToolsResponseSchema = z.object({
  generatedAt: z.string().min(1),
  summary: diagnosticsToolSummarySchema,
  tools: z.array(diagnosticsToolSchema),
});
export type DiagnosticsToolsResponse = z.infer<
  typeof diagnosticsToolsResponseSchema
>;

export const diagnosticsPermissionsResponseSchema = z.object({
  generatedAt: z.string().min(1),
  defaultMode: codingAgentModeSchema,
  effectivePermissionMode: permissionModeSchema,
  configuredPermissionMode: permissionModeSchema.nullable(),
  allowedTools: z.array(codingAgentToolNameSchema).nullable(),
  rules: permissionRulesSchema,
  sandbox: sandboxRuntimeStatusSchema,
  pendingApprovalsPersisted: z.boolean(),
  pendingInteractions: chatInteractionPendingSummarySchema,
  notes: z.array(z.string()),
});
export type DiagnosticsPermissionsResponse = z.infer<
  typeof diagnosticsPermissionsResponseSchema
>;
