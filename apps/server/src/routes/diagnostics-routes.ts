import { existsSync } from "node:fs";
import { Hono } from "hono";
import {
  ANTHROPIC_TOOL_OPTIONAL_PARAMETER_BUDGET,
  codingAgentModes,
  codingToolDescriptions,
  codingToolPermissionRequirements,
  collectToolSchemaPreflight,
  defaultPermissionModeForCodingMode,
  diagnosticsDoctorResponseSchema,
  diagnosticsPermissionsResponseSchema,
  diagnosticsStatusResponseSchema,
  diagnosticsToolsResponseSchema,
  getSandboxRuntimeStatus,
  type CodingAgentMode,
  type DiagnosticCheck,
  type DiagnosticStatus,
  type DiagnosticsDatabase,
  type DiagnosticsTool,
  type DiagnosticsToolSummary,
} from "@lightcode/ai";
import { productName } from "@lightcode/shared";
import { listChatSessions } from "../lib/chat-store";
import { prisma } from "../lib/prisma-client";
import {
  configStatus,
  lightcodeConfigResult,
  resolvedProviderModel,
} from "../lib/runtime-config";
import { getExtensionRuntimeStatus } from "../lib/extension-runtime";

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error.";
}

function combineStatuses(statuses: DiagnosticStatus[]): DiagnosticStatus {
  if (statuses.includes("error")) {
    return "error";
  }

  if (statuses.includes("warn")) {
    return "warn";
  }

  return "ok";
}

async function getDatabaseDiagnostics(): Promise<DiagnosticsDatabase> {
  try {
    const [sessionCount, messageCount] = await Promise.all([
      prisma.chatSession.count(),
      prisma.chatMessage.count(),
    ]);

    return {
      status: "ok",
      reachable: true,
      sessionCount,
      messageCount,
      error: null,
    };
  } catch (error) {
    return {
      status: "error",
      reachable: false,
      sessionCount: null,
      messageCount: null,
      error: getErrorMessage(error),
    };
  }
}

function getProviderDiagnostics() {
  return {
    status:
      resolvedProviderModel.missingCredentialHints.length > 0 ? "warn" : "ok",
    provider: resolvedProviderModel.provider,
    model: resolvedProviderModel.resolvedModelId,
    configuredModel: resolvedProviderModel.configuredModel,
    baseUrlConfigured: resolvedProviderModel.baseUrl !== null,
    missingCredentialHints: resolvedProviderModel.missingCredentialHints,
  } as const;
}

function getToolDiagnostics(): {
  summary: DiagnosticsToolSummary;
  tools: DiagnosticsTool[];
} {
  const preflightByName = new Map(
    collectToolSchemaPreflight().map((entry) => [entry.toolName, entry]),
  );
  const toolNames = Object.keys(codingToolDescriptions) as Array<
    keyof typeof codingToolDescriptions
  >;
  const tools = toolNames.map((toolName) => {
    const providerOptionalPropertyCount =
      preflightByName.get(toolName)?.optionalPropertyCount ?? 0;
    const providerSchemaStatus =
      providerOptionalPropertyCount > ANTHROPIC_TOOL_OPTIONAL_PARAMETER_BUDGET
        ? "error"
        : "ok";

    return {
      name: toolName,
      description: codingToolDescriptions[toolName],
      permissionMode: codingToolPermissionRequirements[toolName],
      activeInModes: Object.entries(codingAgentModes).flatMap(
        ([mode, definition]) =>
          definition.activeTools.includes(toolName)
            ? [mode as CodingAgentMode]
            : [],
      ),
      providerOptionalPropertyCount,
      providerSchemaStatus,
    } satisfies DiagnosticsTool;
  });
  const permissionCounts = tools.reduce(
    (counts, tool) => {
      if (tool.permissionMode === "read-only") {
        counts.readOnly += 1;
      } else if (tool.permissionMode === "workspace-write") {
        counts.workspaceWrite += 1;
      } else {
        counts.dangerFullAccess += 1;
      }

      return counts;
    },
    {
      readOnly: 0,
      workspaceWrite: 0,
      dangerFullAccess: 0,
    },
  );

  return {
    summary: {
      total: tools.length,
      ...permissionCounts,
      providerSchemaStatus: combineStatuses(
        tools.map((tool) => tool.providerSchemaStatus),
      ),
      optionalParameterBudget: ANTHROPIC_TOOL_OPTIONAL_PARAMETER_BUDGET,
    },
    tools,
  };
}

function getExtensionDiagnostics() {
  return getExtensionRuntimeStatus();
}

async function getLatestSessionSummary() {
  try {
    return (await listChatSessions(1))[0] ?? null;
  } catch {
    return null;
  }
}

async function buildStatusPayload() {
  const database = await getDatabaseDiagnostics();
  const provider = getProviderDiagnostics();
  const toolDiagnostics = getToolDiagnostics();
  const sandbox = getSandboxRuntimeStatus(lightcodeConfigResult.config.sandbox);
  const extensionDiagnostics = getExtensionDiagnostics();

  return diagnosticsStatusResponseSchema.parse({
    generatedAt: new Date().toISOString(),
    server: {
      status: "ok",
      name: productName,
      uptimeSeconds: process.uptime(),
      cwd: process.cwd(),
      platform: process.platform,
      bunVersion: Bun.version ?? null,
    },
    provider,
    database,
    config: configStatus,
    sessions: {
      latest: await getLatestSessionSummary(),
    },
    tools: toolDiagnostics.summary,
    extensions: extensionDiagnostics,
    features: {
      sessions: true,
      slashCommands: true,
      permissions: true,
      sandbox: sandbox.enabled,
      webTools: true,
      skills: true,
      mcp: extensionDiagnostics.mcp.configuredServers > 0,
      plugins: extensionDiagnostics.plugins.count > 0,
    },
  });
}

function checkWorkspace(): DiagnosticCheck {
  const cwd = process.cwd();

  return {
    id: "workspace",
    label: "Workspace",
    status: existsSync(cwd) ? "ok" : "error",
    summary: existsSync(cwd)
      ? `Workspace is accessible: ${cwd}`
      : `Workspace is missing: ${cwd}`,
    details: [],
  };
}

async function buildDoctorPayload() {
  const database = await getDatabaseDiagnostics();
  const provider = getProviderDiagnostics();
  const tools = getToolDiagnostics();
  const extensions = getExtensionDiagnostics();
  const sandbox = getSandboxRuntimeStatus(lightcodeConfigResult.config.sandbox);
  const checks: DiagnosticCheck[] = [
    {
      id: "server",
      label: "Server",
      status: "ok",
      summary: `${productName} API is running.`,
      details: [`Uptime: ${Math.round(process.uptime())}s`],
    },
    {
      id: "database",
      label: "Database",
      status: database.status,
      summary: database.reachable
        ? "Database is reachable."
        : "Database is not reachable.",
      details: database.error
        ? [database.error]
        : [
            `${database.sessionCount ?? 0} sessions`,
            `${database.messageCount ?? 0} messages`,
          ],
    },
    {
      id: "provider",
      label: "Provider",
      status: provider.status,
      summary:
        provider.status === "ok"
          ? `${provider.provider} is configured for ${provider.model}.`
          : "Provider credentials are incomplete.",
      details: provider.missingCredentialHints,
    },
    {
      id: "config",
      label: "Config",
      status: "ok",
      summary: "Effective config loaded without exposing secrets.",
      details: configStatus.loadedFiles.map((file) =>
        `${file.scope}: ${file.loaded ? "loaded" : "not loaded"} (${file.path})`,
      ),
    },
    {
      id: "tool-schema",
      label: "Tool Schemas",
      status: tools.summary.providerSchemaStatus,
      summary: `${tools.summary.total} tools are registered; optional schema budget is ${tools.summary.optionalParameterBudget}.`,
      details: [],
    },
    checkWorkspace(),
    {
      id: "sandbox",
      label: "Sandbox",
      status: sandbox.enabled && !sandbox.supported ? "warn" : "ok",
      summary: sandbox.enabled
        ? sandbox.supported
          ? "Sandbox is enabled and supported."
          : "Sandbox is enabled but not supported on this platform."
        : "Sandbox is disabled.",
      details: sandbox.unsupportedReason ? [sandbox.unsupportedReason] : [],
    },
    {
      id: "mcp",
      label: "MCP Servers",
      status: extensions.mcp.degradedServers > 0 ? "warn" : "ok",
      summary:
        extensions.mcp.configuredServers === 0
          ? "No MCP servers configured."
          : `${extensions.mcp.configuredServers} MCP server(s) configured.`,
      details: extensions.mcp.servers.map((server) =>
        `${server.name}: ${server.state}${server.error ? ` (${server.error})` : ""}`,
      ),
    },
    {
      id: "skills",
      label: "Skills",
      status: "ok",
      summary: `${extensions.skills.count} local skill(s) discovered.`,
      details: [],
    },
    {
      id: "plugins",
      label: "Plugins",
      status: "ok",
      summary: `${extensions.plugins.enabled}/${extensions.plugins.count} plugin(s) enabled.`,
      details: [`${extensions.plugins.hooks} hook(s) discovered.`],
    },
  ];

  return diagnosticsDoctorResponseSchema.parse({
    generatedAt: new Date().toISOString(),
    status: combineStatuses(checks.map((check) => check.status)),
    checks,
  });
}

function buildPermissionsPayload() {
  const config = lightcodeConfigResult.config;
  const rules = config.permissions ?? {
    allow: [],
    ask: [],
    deny: [],
  };

  return diagnosticsPermissionsResponseSchema.parse({
    generatedAt: new Date().toISOString(),
    defaultMode: config.defaultMode,
    configuredPermissionMode: config.permissionMode ?? null,
    effectivePermissionMode:
      config.permissionMode ?? defaultPermissionModeForCodingMode(config.defaultMode),
    allowedTools: config.allowedTools ?? null,
    rules,
    sandbox: getSandboxRuntimeStatus(config.sandbox),
    pendingApprovalsPersisted: false,
    notes: [
      "Pending approvals live in the active CLI chat session and are not persisted on the server.",
      "Plan mode is always clamped to read-only at runtime.",
    ],
  });
}

export const diagnosticsRoutes = new Hono()
  .get("/status", async (c) => c.json(await buildStatusPayload()))
  .get("/doctor", async (c) => c.json(await buildDoctorPayload()))
  .get("/tools", (c) => {
    const toolDiagnostics = getToolDiagnostics();

    return c.json(
      diagnosticsToolsResponseSchema.parse({
        generatedAt: new Date().toISOString(),
        summary: toolDiagnostics.summary,
        tools: toolDiagnostics.tools,
      }),
    );
  })
  .get("/permissions", (c) => c.json(buildPermissionsPayload()));
