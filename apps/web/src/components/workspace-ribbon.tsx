import type { CodingMode, PermissionMode, ProviderStatus, Session, Workspace } from "../lib/api";
import { Icon } from "./icons";
import { codingModeSchema, permissionModeSchema } from "../lib/api";

interface WorkspaceRibbonProps {
  placement: "project" | "agent";
  workspace: Workspace | null;
  session: Session | null;
  mode: CodingMode;
  permissionMode: PermissionMode;
  providerStatus: ProviderStatus | null;
  providerStatusError: boolean;
  isRunning: boolean;
  isCreating: boolean;
  isPickingProject: boolean;
  onOpenProject: () => void;
  onModeChange: (mode: CodingMode) => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
  onOpenModels: () => void;
}

const permissionLabels: Record<PermissionMode, string> = {
  "read-only": "Read only",
  "workspace-write": "Can edit",
  "danger-full-access": "Full access",
};

/** "openrouter/anthropic/claude-x" reads as "claude-x"; the full id stays in the tooltip. */
function shortModelName(model: string) {
  return model.split("/").at(-1) || model;
}

export function WorkspaceRibbon({
  placement,
  workspace,
  session,
  mode,
  permissionMode,
  providerStatus,
  providerStatusError,
  isRunning,
  isCreating,
  isPickingProject,
  onOpenProject,
  onModeChange,
  onPermissionModeChange,
  onOpenModels,
}: WorkspaceRibbonProps) {
  const pathLabel = session?.pathLabel ?? session?.cwd ?? workspace?.pathLabel ?? "Choose a local project";
  // Tooltips show the real folder; browser grants label it as "Desktop/foo".
  const hostPathTitle = session?.cwd ?? workspace?.hostPath ?? pathLabel;
  const normalizedSessionPath = (session?.pathLabel ?? session?.cwd)?.replaceAll("\\", "/").replace(/\/$/, "");
  const sessionProjectName = normalizedSessionPath?.split("/").at(-1);
  const projectName = session ? sessionProjectName || session.title || "Project" : workspace?.name ?? "Open folder";
  const needsProviderSetup = Boolean(providerStatus?.missingCredentialHints.length);
  const statusLabel = isRunning
    ? "Live run"
    : isCreating
      ? "Opening"
      : providerStatusError
        ? "Server issue"
        : needsProviderSetup
          ? "Setup needed"
          : providerStatus
            ? "Ready"
            : "Checking";
  const statusDetail = providerStatusError
    ? "Lightcode could not read provider status."
    : needsProviderSetup
      ? providerStatus?.missingCredentialHints.join(" ")
      : undefined;
  const effectivePermissionMode = mode === "plan" ? "read-only" : permissionMode;
  const modeDisabled = isRunning;
  const permissionDisabled = isRunning || mode === "plan";

  return (
    <div className={`workspace-controls workspace-controls-${placement}`} role="group" aria-label={placement === "project" ? "Project controls" : "Agent controls"}>
      {placement === "project" ? <>
      {providerStatusError || needsProviderSetup || isCreating ? <div className="ribbon-status" role="status" title={statusDetail}>
        <span className={isRunning ? "live-dot active" : "live-dot"} />
        {statusLabel}
      </div> : null}

      <button
        className="workspace-path"
        type="button"
        onClick={onOpenProject}
        title={hostPathTitle}
        aria-label={`Open project folder: ${projectName}`}
        disabled={isPickingProject}
        aria-busy={isPickingProject}
      >
        <span className="workspace-icon">
          {isPickingProject ? (
            <span className="inline-spinner" aria-hidden="true" />
          ) : (
            <Icon name="folder" size={15} />
          )}
        </span>
        <span className="workspace-path-copy">
          <strong>{isPickingProject ? "Opening folder picker" : projectName}</strong>
        </span>
        <Icon name="chevron-down" size={14} />
      </button>
      </> : <>
      {providerStatus?.selectedModel || session?.model ? (
        <button type="button" className="ribbon-model" onClick={onOpenModels} disabled={isRunning || !providerStatus} aria-label="Choose model" title={providerStatus?.selectedModel ?? session?.model ?? undefined}>
          <span>{shortModelName(providerStatus?.selectedModel ?? session?.model ?? "")}</span><Icon name="chevron-down" size={13} />
        </button>
      ) : null}

      <label className={modeDisabled ? "ribbon-select disabled" : "ribbon-select"}>
        <span className="sr-only">Agent mode</span>
        <span className="ribbon-select-value" aria-hidden="true">
          {mode === "build" ? "Build" : "Plan"}
        </span>
        <select
          aria-label="Agent mode"
          value={mode}
          onChange={(event) => onModeChange(codingModeSchema.parse(event.currentTarget.value))}
          disabled={modeDisabled}
        >
          <option value="build">Build</option>
          <option value="plan">Plan</option>
        </select>
        {modeDisabled ? null : <Icon name="chevron-down" size={13} />}
      </label>

      <label
        className={
          permissionDisabled
            ? "ribbon-select permission-select disabled"
            : "ribbon-select permission-select"
        }
        title={mode === "plan" ? "Permission: Read (Plan mode is always read-only)" : `Permission: ${permissionLabels[permissionMode]}`}
      >
        <span className="sr-only">Permission mode</span>
        <span className="ribbon-select-value" aria-hidden="true">
          {permissionLabels[effectivePermissionMode]}
        </span>
        <select
          aria-label="Permission mode"
          value={effectivePermissionMode}
          onChange={(event) => onPermissionModeChange(permissionModeSchema.parse(event.currentTarget.value))}
          disabled={permissionDisabled}
        >
          {Object.entries(permissionLabels).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        {permissionDisabled ? null : <Icon name="chevron-down" size={13} />}
      </label>
      </>}
    </div>
  );
}
