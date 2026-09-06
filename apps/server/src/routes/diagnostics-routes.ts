import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { networkFetch } from "@lightcode/shared/network";
import {
  ANTHROPIC_TOOL_OPTIONAL_PARAMETER_BUDGET,
  codingToolDescriptions,
  codingToolPermissionRequirements,
  codingToolRegistry,
  collectToolSchemaPreflight,
  defaultPermissionModeForCodingMode,
  diagnosticsDoctorResponseSchema,
  diagnosticsPermissionsResponseSchema,
  diagnosticsStatusResponseSchema,
  diagnosticsToolsResponseSchema,
  getSandboxRuntimeStatus,
  type DiagnosticCheck,
  type DiagnosticStatus,
  type DiagnosticsDatabase,
  type DiagnosticsTool,
  type DiagnosticsToolSummary,
  type ResolvedWebSearchCapability,
} from "@lightcode/ai";
import {
  getErrorMessage,
  getLogDirectory,
  productName,
} from "@lightcode/shared";
import { listChatSessions } from "../lib/chat-store";
import { summarizePendingChatInteractions } from "../lib/chat-interaction-store";
import { prisma } from "../lib/prisma-client";
import {
  configStatus,
  lightcodeConfigResult,
  resolvedProviderModel,
} from "../lib/runtime-config";
import { getExtensionRuntimeStatus } from "../lib/extension-runtime";

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
      permissionSubject: codingToolRegistry[toolName].permissionSubject,
      activeInModes: [...codingToolRegistry[toolName].modes],
      availability: codingToolRegistry[toolName].availability,
      execution: codingToolRegistry[toolName].execution,
      activation: codingToolRegistry[toolName].activation,
      outputPolicy: codingToolRegistry[toolName].outputPolicy,
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
    webSearch: resolvedProviderModel.webSearchCapability,
    extensions: extensionDiagnostics,
    features: {
      sessions: true,
      slashCommands: true,
      permissions: true,
      sandbox: sandbox.enabled,
      webTools: resolvedProviderModel.webSearchCapability.available,
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

export function createWebSearchDiagnosticCheck(
  webSearch: ResolvedWebSearchCapability,
): DiagnosticCheck {
  return {
    id: "web-search",
    label: "Web Search",
    status:
      webSearch.available || webSearch.backend === "disabled" ? "ok" : "warn",
    summary: webSearch.available
      ? `Web search is ready through ${webSearch.backend} (${webSearch.execution}).`
      : webSearch.backend === "disabled"
        ? "Web search is intentionally disabled."
        : "Web search is unavailable.",
    details: [
      ...(webSearch.reason ? [webSearch.reason] : []),
      `Limits: ${webSearch.limits.maxUsesPerTurn} uses, ${webSearch.limits.maxResults} results/search, ${webSearch.limits.maxTotalResults} results total, ${webSearch.limits.maxCharactersPerResult} chars/result.`,
    ],
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
    createWebSearchDiagnosticCheck(resolvedProviderModel.webSearchCapability),
    checkWorkspace(),
    {
      id: "sandbox",
      label: "Sandbox",
      status: sandbox.enabled && !sandbox.supported ? "warn" : "ok",
      summary: sandbox.enabled
        ? sandbox.supported
          ? "Process-level sandbox guards are enabled."
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

async function buildPermissionsPayload() {
  const config = lightcodeConfigResult.config;
  const rules = config.permissions ?? {
    allow: [],
    ask: [],
    deny: [],
  };
  const notes = [
    "Pending approvals and plan questions are checkpointed for session recovery.",
    "Plan mode is always clamped to read-only at runtime.",
  ];
  let pendingInteractions = {
    total: 0,
    toolApprovals: 0,
    userPrompts: 0,
    stale: 0,
    recoverable: 0,
  };

  try {
    pendingInteractions = await summarizePendingChatInteractions();
  } catch (error) {
    notes.unshift(
      `Pending interaction summary is unavailable: ${getErrorMessage(error)}`,
    );
  }

  return diagnosticsPermissionsResponseSchema.parse({
    generatedAt: new Date().toISOString(),
    defaultMode: config.defaultMode,
    configuredPermissionMode: config.permissionMode ?? null,
    effectivePermissionMode:
      config.permissionMode ?? defaultPermissionModeForCodingMode(config.defaultMode),
    allowedTools: config.allowedTools ?? null,
    rules,
    sandbox: getSandboxRuntimeStatus(config.sandbox),
    pendingApprovalsPersisted: true,
    pendingInteractions,
    notes,
  });
}

const connectivityProbeTimeoutMs = 10_000;

/**
 * Probes the configured provider endpoint from the server process — the
 * exact network path chat requests take — and reports the raw TLS/proxy/DNS
 * error when it fails. Turns "it doesn't work on my work laptop" into a
 * one-request diagnosis.
 */
async function buildConnectivityPayload() {
  const baseUrl =
    resolvedProviderModel.baseUrl ??
    (resolvedProviderModel.provider === "anthropic"
      ? "https://api.anthropic.com/v1"
      : null);

  const proxyEnvironment = {
    httpsProxy: Boolean(Bun.env.HTTPS_PROXY ?? Bun.env.https_proxy),
    httpProxy: Boolean(Bun.env.HTTP_PROXY ?? Bun.env.http_proxy),
    noProxy: Boolean(Bun.env.NO_PROXY ?? Bun.env.no_proxy),
    extraCaCerts: Boolean(Bun.env.NODE_EXTRA_CA_CERTS || Bun.env.LIGHTCODE_CA_CERTS || Bun.env.SSL_CERT_FILE),
  };

  if (!baseUrl) {
    return {
      generatedAt: new Date().toISOString(),
      provider: resolvedProviderModel.provider,
      target: null,
      reachable: false,
      statusCode: null,
      latencyMs: null,
      error: "No provider base URL is configured.",
      proxyEnvironment,
    };
  }

  const target = new URL("models", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const startedAt = performance.now();

  try {
    const response = await networkFetch(target, {
      signal: AbortSignal.timeout(connectivityProbeTimeoutMs),
    });

    return {
      generatedAt: new Date().toISOString(),
      provider: resolvedProviderModel.provider,
      target: target.toString(),
      // Any HTTP status proves TLS + proxy + DNS all work; auth failures
      // (401/403) are still "reachable".
      reachable: true,
      statusCode: response.status,
      latencyMs: Math.round(performance.now() - startedAt),
      error: null,
      proxyEnvironment,
    };
  } catch (error) {
    return {
      generatedAt: new Date().toISOString(),
      provider: resolvedProviderModel.provider,
      target: target.toString(),
      reachable: false,
      statusCode: null,
      latencyMs: Math.round(performance.now() - startedAt),
      error: getErrorMessage(error),
      proxyEnvironment,
    };
  }
}

const maxLogTailLines = 1000;

async function buildLogsTailPayload(requestedLines: number) {
  const directory = getLogDirectory();
  const lineCount = Math.min(
    Math.max(Number.isFinite(requestedLines) ? requestedLines : 200, 1),
    maxLogTailLines,
  );

  let latestFile: string | null = null;
  try {
    const logFiles = readdirSync(directory)
      .filter((name) => /^server-\d{4}-\d{2}-\d{2}\.log$/.test(name))
      .sort();
    latestFile = logFiles.at(-1) ?? null;
  } catch {
    latestFile = null;
  }

  if (!latestFile) {
    return {
      generatedAt: new Date().toISOString(),
      file: null,
      lines: [] as string[],
    };
  }

  const filePath = path.join(directory, latestFile);
  const content = await Bun.file(filePath).text();
  const lines = content.split("\n").filter((line) => line.length > 0);

  return {
    generatedAt: new Date().toISOString(),
    file: filePath,
    lines: lines.slice(-lineCount),
  };
}

export const diagnosticsRoutes = new Hono()
  .get("/status", async (c) => c.json(await buildStatusPayload()))
  .get("/logs/tail", async (c) =>
    c.json(await buildLogsTailPayload(Number(c.req.query("lines") ?? 200))),
  )
  .get("/connectivity", async (c) => c.json(await buildConnectivityPayload()))
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
  .get("/permissions", async (c) => c.json(await buildPermissionsPayload()));
