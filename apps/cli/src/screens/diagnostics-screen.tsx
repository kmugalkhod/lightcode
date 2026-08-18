import { TextAttributes, typeRole } from "../ui/cli-theme";
import { useKeyboard } from "@opentui/react";
import {
  diagnosticsDoctorResponseSchema,
  diagnosticsPermissionsResponseSchema,
  diagnosticsStatusResponseSchema,
  diagnosticsToolsResponseSchema,
  lightcodeConfigStatusSchema,
  type DiagnosticStatus,
  type DiagnosticsDoctorResponse,
  type DiagnosticsPermissionsResponse,
  type DiagnosticsStatusResponse,
  type DiagnosticsToolsResponse,
  type LightcodeConfigStatus,
  codingAgentModeSchema,
  permissionModeSchema,
} from "@lightcode/ai";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { z } from "zod";
import { client } from "../lib/client";
import { cliTheme } from "../ui/cli-theme";
import { formatDate, getErrorMessage } from "../utils/text-utils";

export type DiagnosticsScreenKind =
  | "status"
  | "doctor"
  | "permissions"
  | "tools"
  | "config";

type DiagnosticsPayload =
  | DiagnosticsStatusResponse
  | DiagnosticsDoctorResponse
  | DiagnosticsPermissionsResponse
  | DiagnosticsToolsResponse
  | LightcodeConfigStatus;

const diagnosticsRouteStateSchema = z.object({
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  mode: codingAgentModeSchema.optional(),
  permissionMode: permissionModeSchema.optional().nullable(),
  messageCount: z.number().int().nonnegative().optional(),
  pendingApprovalCount: z.number().int().nonnegative().optional(),
});

const pageTitles = {
  status: "Status",
  doctor: "Doctor",
  permissions: "Permissions",
  tools: "Tools",
  config: "Config",
} satisfies Record<DiagnosticsScreenKind, string>;

function getStatusColor(status: DiagnosticStatus) {
  if (status === "ok") {
    return cliTheme.semantic.success;
  }

  if (status === "warn") {
    return cliTheme.semantic.warning;
  }

  return cliTheme.semantic.error;
}

function formatNullable(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return "not set";
  }

  return String(value);
}

function InfoRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number | null | undefined;
  tone?: DiagnosticStatus | "muted";
}) {
  const valueColor =
    tone === "muted" || tone === undefined
      ? cliTheme.text.secondary
      : getStatusColor(tone);

  return (
    <box flexDirection="row" gap={1}>
      <text fg={cliTheme.text.muted} width={24}>
        {label}
      </text>
      <text fg={valueColor}>{formatNullable(value)}</text>
    </box>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <box
      flexDirection="column"
      gap={1}
      paddingX={1}
      paddingY={1}
      borderStyle="single"
      borderColor={cliTheme.borders.subtle}
      backgroundColor={cliTheme.surfaces.panel}
    >
      <text fg={cliTheme.accent.primary} attributes={TextAttributes.BOLD}>
        {title}
      </text>
      {children}
    </box>
  );
}

function renderStatus(payload: DiagnosticsStatusResponse, routeState: unknown) {
  const parsedRouteState = diagnosticsRouteStateSchema.safeParse(routeState);
  const currentSession = parsedRouteState.success ? parsedRouteState.data : {};
  const latestSession = payload.sessions.latest;

  return (
    <>
      <Section title="Current Chat">
        <InfoRow label="Session" value={currentSession.sessionId ?? "not in chat"} />
        <InfoRow label="Mode" value={currentSession.mode ?? "not set"} />
        <InfoRow
          label="Permission mode"
          value={currentSession.permissionMode ?? "not set"}
        />
        <InfoRow label="CWD" value={currentSession.cwd ?? payload.server.cwd} />
        <InfoRow label="Messages" value={currentSession.messageCount ?? null} />
        <InfoRow
          label="Pending approvals"
          value={currentSession.pendingApprovalCount ?? 0}
          tone={
            (currentSession.pendingApprovalCount ?? 0) > 0 ? "warn" : "ok"
          }
        />
      </Section>

      <Section title="Runtime">
        <InfoRow label="Server" value={payload.server.status} tone={payload.server.status} />
        <InfoRow label="Provider" value={payload.provider.provider} tone={payload.provider.status} />
        <InfoRow label="Model" value={payload.provider.model} />
        <InfoRow label="Database" value={payload.database.status} tone={payload.database.status} />
        <InfoRow label="Tool count" value={payload.tools.total} />
        <InfoRow label="Schema status" value={payload.tools.providerSchemaStatus} tone={payload.tools.providerSchemaStatus} />
        <InfoRow
          label="Web search"
          value={`${payload.webSearch.backend} (${payload.webSearch.execution})`}
          tone={payload.webSearch.available ? "ok" : payload.webSearch.backend === "disabled" ? "muted" : "warn"}
        />
      </Section>

      <Section title="Extensions">
        <InfoRow label="Skills" value={payload.extensions.skills.count} />
        <InfoRow label="MCP servers" value={payload.extensions.mcp.configuredServers} />
        <InfoRow label="MCP running" value={payload.extensions.mcp.runningServers} />
        <InfoRow
          label="MCP degraded"
          value={payload.extensions.mcp.degradedServers}
          tone={payload.extensions.mcp.degradedServers > 0 ? "warn" : "ok"}
        />
        <InfoRow label="Plugins" value={payload.extensions.plugins.count} />
        <InfoRow label="Plugin hooks" value={payload.extensions.plugins.hooks} />
      </Section>

      <Section title="Latest Saved Session">
        {latestSession ? (
          <>
            <InfoRow label="Session" value={latestSession.id} />
            <InfoRow label="Title" value={latestSession.title ?? latestSession.latestUserPromptPreview} />
            <InfoRow label="Messages" value={latestSession.messageCount} />
            <InfoRow label="Updated" value={formatDate(latestSession.updatedAt)} />
          </>
        ) : (
          <text fg={cliTheme.text.muted}>No saved sessions yet.</text>
        )}
      </Section>
    </>
  );
}

function renderDoctor(payload: DiagnosticsDoctorResponse) {
  return (
    <Section title={`Overall: ${payload.status}`}>
      {payload.checks.map((check) => (
        <box key={check.id} flexDirection="column" paddingY={1}>
          <box flexDirection="row" gap={1}>
            <text fg={getStatusColor(check.status)} attributes={TextAttributes.BOLD} width={8}>
              {check.status.toUpperCase()}
            </text>
            <text fg={cliTheme.text.primary} attributes={TextAttributes.BOLD}>
              {check.label}
            </text>
          </box>
          <text fg={cliTheme.text.secondary}>{check.summary}</text>
          {check.details.map((detail) => (
            <text key={detail} fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
              {detail}
            </text>
          ))}
        </box>
      ))}
    </Section>
  );
}

function renderPermissions(payload: DiagnosticsPermissionsResponse, routeState: unknown) {
  const parsedRouteState = diagnosticsRouteStateSchema.safeParse(routeState);
  const currentSession = parsedRouteState.success ? parsedRouteState.data : {};

  return (
    <>
      <Section title="Current Chat">
        <InfoRow label="Mode" value={currentSession.mode ?? payload.defaultMode} />
        <InfoRow
          label="Permission mode"
          value={currentSession.permissionMode ?? payload.effectivePermissionMode}
        />
        <InfoRow
          label="Pending approvals"
          value={currentSession.pendingApprovalCount ?? 0}
          tone={
            (currentSession.pendingApprovalCount ?? 0) > 0 ? "warn" : "ok"
          }
        />
        <InfoRow
          label="Persisted pending"
          value={payload.pendingInteractions.total}
          tone={payload.pendingInteractions.total > 0 ? "warn" : "ok"}
        />
      </Section>

      <Section title="Policy">
        <InfoRow label="Default mode" value={payload.defaultMode} />
        <InfoRow label="Configured permission" value={payload.configuredPermissionMode} />
        <InfoRow label="Effective permission" value={payload.effectivePermissionMode} />
        <InfoRow
          label="Allowed tools"
          value={payload.allowedTools ? payload.allowedTools.join(", ") : "all policy-allowed tools"}
        />
        <InfoRow label="Allow rules" value={payload.rules.allow?.length ?? 0} />
        <InfoRow label="Ask rules" value={payload.rules.ask?.length ?? 0} />
        <InfoRow label="Deny rules" value={payload.rules.deny?.length ?? 0} />
      </Section>

      <Section title="Recovery">
        <InfoRow label="Tool approvals" value={payload.pendingInteractions.toolApprovals} />
        <InfoRow label="User prompts" value={payload.pendingInteractions.userPrompts} />
        <InfoRow
          label="Stale pending"
          value={payload.pendingInteractions.stale}
          tone={payload.pendingInteractions.stale > 0 ? "warn" : "ok"}
        />
        <InfoRow label="Recoverable" value={payload.pendingInteractions.recoverable} />
      </Section>

      <Section title="Sandbox">
        <InfoRow label="Enabled" value={payload.sandbox.enabled ? "yes" : "no"} />
        <InfoRow label="Mode" value={payload.sandbox.mode} />
        <InfoRow label="Isolation" value={payload.sandbox.isolation} tone="warn" />
        <InfoRow label="Supported" value={payload.sandbox.supported ? "yes" : "no"} tone={payload.sandbox.supported ? "ok" : "warn"} />
        {payload.sandbox.unsupportedReason ? (
          <text fg={cliTheme.semantic.warning}>{payload.sandbox.unsupportedReason}</text>
        ) : null}
      </Section>

      <Section title="Notes">
        {payload.notes.map((note) => (
          <text key={note} fg={cliTheme.text.muted}>{note}</text>
        ))}
      </Section>
    </>
  );
}

function renderTools(payload: DiagnosticsToolsResponse) {
  return (
    <>
      <Section title="Summary">
        <InfoRow label="Total" value={payload.summary.total} />
        <InfoRow label="Read-only" value={payload.summary.readOnly} />
        <InfoRow label="Workspace-write" value={payload.summary.workspaceWrite} />
        <InfoRow label="Danger-full-access" value={payload.summary.dangerFullAccess} />
        <InfoRow label="Schema status" value={payload.summary.providerSchemaStatus} tone={payload.summary.providerSchemaStatus} />
      </Section>

      <Section title="Tool Catalog">
        {payload.tools.map((tool) => (
          <box key={tool.name} flexDirection="column" paddingY={1}>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={cliTheme.text.primary} attributes={TextAttributes.BOLD}>
                {tool.name}
              </text>
              <text fg={getStatusColor(tool.providerSchemaStatus)}>
                {tool.permissionMode}
              </text>
            </box>
            <text fg={cliTheme.text.secondary}>{tool.description}</text>
            <text fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
              Modes: {tool.activeInModes.join(", ") || "none"} | {tool.activation} | {tool.execution} | output: {tool.outputPolicy} | optional fields: {tool.providerOptionalPropertyCount}
            </text>
          </box>
        ))}
      </Section>
    </>
  );
}

function renderConfig(payload: LightcodeConfigStatus) {
  return (
    <>
      <Section title="Effective Config">
        <InfoRow label="Provider" value={payload.selectedProvider} />
        <InfoRow label="Configured model" value={payload.configuredModel} />
        <InfoRow label="Selected model" value={payload.selectedModel} />
        <InfoRow label="Base URL" value={payload.baseUrl ? "configured" : "default"} />
        <InfoRow label="Default mode" value={payload.defaultMode} />
        <InfoRow label="Permission mode" value={payload.permissionMode} />
        <InfoRow label="Max output tokens" value={payload.maxOutputTokens} />
        <InfoRow label="Max steps" value={payload.maxSteps} />
        <InfoRow
          label="Web search"
          value={`${payload.webSearch.backend} (${payload.webSearch.execution})`}
          tone={payload.webSearch.available ? "ok" : payload.webSearch.backend === "disabled" ? "muted" : "warn"}
        />
        <InfoRow
          label="Search limits"
          value={`${payload.webSearch.limits.maxUsesPerTurn} uses / ${payload.webSearch.limits.maxTotalResults} results`}
        />
      </Section>

      {payload.webSearch.reason ? (
        <Section title="Web Search Setup">
          <text fg={cliTheme.semantic.warning}>{payload.webSearch.reason}</text>
        </Section>
      ) : null}

      <Section title="Loaded Files">
        {payload.loadedFiles.map((file) => (
          <box key={`${file.scope}:${file.path}`} flexDirection="column">
            <text fg={file.loaded ? cliTheme.semantic.success : cliTheme.text.muted}>
              {file.scope}: {file.loaded ? "loaded" : file.exists ? "not loaded" : "missing"}
            </text>
            <text fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
              {file.path}
            </text>
          </box>
        ))}
      </Section>

      {payload.missingCredentialHints.length > 0 ? (
        <Section title="Credential Hints">
          {payload.missingCredentialHints.map((hint) => (
            <text key={hint} fg={cliTheme.semantic.warning}>{hint}</text>
          ))}
        </Section>
      ) : null}
    </>
  );
}

export function DiagnosticsScreen({ kind }: { kind: DiagnosticsScreenKind }) {
  const location = useLocation();
  const [payload, setPayload] = useState<DiagnosticsPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const title = pageTitles[kind];

  const loadDiagnostics = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      if (kind === "status") {
        const response = await client.diagnostics.status.$get();
        const rawPayload = await response.json();
        setPayload(diagnosticsStatusResponseSchema.parse(rawPayload));
      } else if (kind === "doctor") {
        const response = await client.diagnostics.doctor.$get();
        const rawPayload = await response.json();
        setPayload(diagnosticsDoctorResponseSchema.parse(rawPayload));
      } else if (kind === "permissions") {
        const response = await client.diagnostics.permissions.$get();
        const rawPayload = await response.json();
        setPayload(diagnosticsPermissionsResponseSchema.parse(rawPayload));
      } else if (kind === "tools") {
        const response = await client.diagnostics.tools.$get();
        const rawPayload = await response.json();
        setPayload(diagnosticsToolsResponseSchema.parse(rawPayload));
      } else {
        const response = await client.config.status.$get();
        const rawPayload = await response.json();
        setPayload(lightcodeConfigStatusSchema.parse(rawPayload));
      }
    } catch (error) {
      setErrorMessage(getErrorMessage(error, `Unable to load ${title}.`));
    } finally {
      setIsLoading(false);
    }
  }, [kind, title]);

  useEffect(() => {
    void loadDiagnostics();
  }, [loadDiagnostics]);

  useKeyboard((keyEvent) => {
    if (keyEvent.name.toLowerCase() !== "r") {
      return;
    }

    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    void loadDiagnostics();
  });

  const content = useMemo(() => {
    if (!payload) {
      return null;
    }

    if (kind === "status") {
      return renderStatus(payload as DiagnosticsStatusResponse, location.state);
    }

    if (kind === "doctor") {
      return renderDoctor(payload as DiagnosticsDoctorResponse);
    }

    if (kind === "permissions") {
      return renderPermissions(payload as DiagnosticsPermissionsResponse, location.state);
    }

    if (kind === "tools") {
      return renderTools(payload as DiagnosticsToolsResponse);
    }

    return renderConfig(payload as LightcodeConfigStatus);
  }, [kind, location.state, payload]);

  return (
    <box width="100%" height="100%" flexDirection="column" gap={1}>
      <box flexDirection="row" justifyContent="space-between" paddingX={1}>
        <text {...typeRole("title")}>{title}</text>
        <text fg={cliTheme.text.muted}>
          {isLoading ? "loading..." : "press r to refresh"}
        </text>
      </box>

      {errorMessage ? (
        <box paddingX={1}>
          <text fg={cliTheme.semantic.error}>{errorMessage}</text>
        </box>
      ) : null}

      <scrollbox flexGrow={1} flexDirection="column" gap={1}>
        {content}
      </scrollbox>
    </box>
  );
}
