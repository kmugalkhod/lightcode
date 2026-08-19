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

  return (
    <header className="workspace-ribbon">
      <button className="icon-button mobile-only ribbon-menu" type="button" onClick={onOpenMenu} aria-label="Open sessions">
        <Icon name="menu" />
      </button>
      <button className="workspace-path" type="button" onClick={onOpenProject} title={pathLabel}>
        <span className="workspace-icon"><Icon name="folder-open" size={16} /></span>
        <span className="workspace-path-copy">
          <strong>{projectName}</strong>
          <small>{pathLabel}</small>
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

      <label className="ribbon-select">
        <span className="sr-only">Agent mode</span>
        <Icon name="code" size={15} />
        <select value={mode} onChange={(event) => onModeChange(event.currentTarget.value as CodingMode)} disabled={isRunning}>
          <option value="build">Build</option>
          <option value="plan">Plan</option>
        </select>
        <Icon name="chevron-down" size={13} />
      </label>

      <label
        className="ribbon-select permission-select"
        title={mode === "plan" ? "Permission: Read (Plan mode is always read-only)" : `Permission: ${permissionLabels[permissionMode]}`}
      >
        <span className="sr-only">Permission mode</span>
        <Icon name="shield" size={15} />
        <select
          value={effectivePermissionMode}
          onChange={(event) => onPermissionModeChange(event.currentTarget.value as PermissionMode)}
          disabled={isRunning || mode === "plan"}
        >
          {Object.entries(permissionLabels).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <Icon name="chevron-down" size={13} />
      </label>
    </header>
  );
}
