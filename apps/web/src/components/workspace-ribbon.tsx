import type { CodingMode, PermissionMode, ProviderStatus, Session, Workspace } from "../lib/api";
import { Icon } from "./icons";

interface WorkspaceRibbonProps {
  workspace: Workspace | null;
  session: Session | null;
  mode: CodingMode;
  permissionMode: PermissionMode;
  providerStatus: ProviderStatus | null;
  providerStatusError: boolean;
  isRunning: boolean;
  isCreating: boolean;
  isPickingProject: boolean;
  onOpenMenu: () => void;
  onOpenProject: () => void;
  onModeChange: (mode: CodingMode) => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
}

const permissionLabels: Record<PermissionMode, string> = {
  "read-only": "Read",
  "workspace-write": "Write",
  "danger-full-access": "Full",
};

export function WorkspaceRibbon({
  workspace,
  session,
  mode,
  permissionMode,
  providerStatus,
  providerStatusError,
  isRunning,
  isCreating,
  isPickingProject,
  onOpenMenu,
  onOpenProject,
  onModeChange,
  onPermissionModeChange,
}: WorkspaceRibbonProps) {
  const pathLabel = session?.pathLabel ?? session?.cwd ?? workspace?.pathLabel ?? "Choose a local project";
  const normalizedSessionPath = (session?.pathLabel ?? session?.cwd)?.replaceAll("\\", "/").replace(/\/$/, "");
  const sessionProjectName = normalizedSessionPath?.split("/").at(-1);
  const projectName = session ? sessionProjectName || session.title || "Project" : workspace?.name ?? "Project";
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
    <header className="workspace-ribbon">
      <button className="icon-button mobile-only ribbon-menu" type="button" onClick={onOpenMenu} aria-label="Open sessions">
        <Icon name="menu" />
      </button>
      <button
        className="workspace-path"
        type="button"
        onClick={onOpenProject}
        title={pathLabel}
        disabled={isPickingProject}
        aria-busy={isPickingProject}
      >
        <span className="workspace-icon">
          {isPickingProject ? (
            <span className="inline-spinner" aria-hidden="true" />
          ) : (
            <Icon name="folder-open" size={16} />
          )}
        </span>
        <span className="workspace-path-copy">
          <strong>{isPickingProject ? "Opening folder picker" : projectName}</strong>
          <small>{isPickingProject ? "Choose a project in the system dialog" : pathLabel}</small>
        </span>
        <Icon name="chevron-down" size={15} />
      </button>

      <div className="ribbon-status" role="status" title={statusDetail}>
        <span className={isRunning ? "live-dot active" : "live-dot"} />
        {statusLabel}
      </div>

      <div className="ribbon-spacer" />

      {providerStatus?.selectedModel || session?.model ? (
        <span className="ribbon-model" title={providerStatus?.selectedModel ?? session?.model ?? undefined}>
          <Icon name="agent" size={15} />
          {providerStatus?.selectedModel ?? session?.model}
        </span>
      ) : null}

      <label className={modeDisabled ? "ribbon-select disabled" : "ribbon-select"}>
        <span className="sr-only">Agent mode</span>
        <Icon name="code" size={15} />
        <span className="ribbon-select-value" aria-hidden="true">
          {mode === "build" ? "Build" : "Plan"}
        </span>
        <select
          aria-label="Agent mode"
          value={mode}
          onChange={(event) => onModeChange(event.currentTarget.value as CodingMode)}
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
        <Icon name="shield" size={15} />
        <span className="ribbon-select-value" aria-hidden="true">
          {permissionLabels[effectivePermissionMode]}
        </span>
        <select
          aria-label="Permission mode"
          value={effectivePermissionMode}
          onChange={(event) => onPermissionModeChange(event.currentTarget.value as PermissionMode)}
          disabled={permissionDisabled}
        >
          {Object.entries(permissionLabels).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        {permissionDisabled ? null : <Icon name="chevron-down" size={13} />}
      </label>
    </header>
  );
}
