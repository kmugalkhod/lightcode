import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatSurface } from "./components/chat-surface";
import { CommandComposer } from "./components/command-composer";
import { Icon } from "./components/icons";
import { ProjectBrowser } from "./components/project-browser";
import { SessionRail } from "./components/session-rail";
import { WorkspaceRibbon } from "./components/workspace-ribbon";
import {
  createAuthenticatedFetch,
  createLightcodeApi,
  LightcodeApiError,
  loadStoredWorkspace,
  readLaunchToken,
  storeWorkspace,
  type CodingMode,
  type PermissionMode,
  type ProviderStatus,
  type Session,
  type Workspace,
} from "./lib/api";
import type { SlashCommandDefinition } from "./lib/slash-command-registry";
import {
  executeWebCommand,
  type CommandResult,
} from "./lib/web-command-executor";

const activeSessionStorageKey = "lightcode.web.active-session";
const newSessionMode: CodingMode = "plan";
const newSessionPermissionMode: PermissionMode = "read-only";

function isWebAuthorizationFailure(cause: unknown): cause is LightcodeApiError {
  if (!(cause instanceof LightcodeApiError)) return false;
  const code =
    cause.payload && typeof cause.payload === "object"
      ? Reflect.get(cause.payload, "code")
      : null;
  return cause.status === 401 || (typeof code === "string" && code.startsWith("web_auth_"));
}

function safeSessionStorage(): Storage {
  return window.sessionStorage;
}

function bootstrapLaunchToken() {
  try {
    const result = readLaunchToken({
      fragment: window.location.hash,
      storage: safeSessionStorage(),
    });
    if (result.fromFragment) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    return result.token;
  } catch {
    return null;
  }
}

function initialWorkspace(): Workspace | null {
  try {
    return loadStoredWorkspace(safeSessionStorage());
  } catch {
    return null;
  }
}

export function App() {
  const [token] = useState(bootstrapLaunchToken);
  const [workspace, setWorkspace] = useState<Workspace | null>(initialWorkspace);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [initialPrompt, setInitialPrompt] = useState<{ sessionId: string; text: string } | null>(null);
  const [mode, setMode] = useState<CodingMode>(newSessionMode);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(newSessionPermissionMode);
  const [isBrowserOpen, setIsBrowserOpen] = useState(() => !initialWorkspace());
  const [isRailOpen, setIsRailOpen] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isLoadingSessions, setIsLoadingSessions] = useState(Boolean(token));
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [authorizationError, setAuthorizationError] = useState<string | null>(null);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [providerStatusError, setProviderStatusError] = useState(false);
  const projectBrowserTriggerRef = useRef<HTMLElement | null>(null);
  const railTriggerRef = useRef<HTMLElement | null>(null);

  const api = useMemo(() => {
    if (!token) return null;
    return createLightcodeApi(createAuthenticatedFetch(token));
  }, [token]);

  const loadSessions = useCallback(async () => {
    if (!api) return;
    setIsLoadingSessions(true);
    setSessionError(null);
    try {
      const loaded = await api.listSessions();
      setSessions(loaded);
      setActiveSession((current) => {
        const savedId = current?.id ?? safeSessionStorage().getItem(activeSessionStorageKey);
        const restored = loaded.find((session) => session.id === savedId) ?? null;
        if (restored) {
          setMode(restored.mode);
          setPermissionMode(restored.permissionMode ?? "read-only");
        }
        return restored;
      });
    } catch (cause) {
      if (isWebAuthorizationFailure(cause)) {
        setAuthorizationError(cause.message);
      } else {
        setSessionError(cause instanceof Error ? cause.message : "Unable to load sessions.");
      }
    } finally {
      setIsLoadingSessions(false);
    }
  }, [api]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (!api) return;
    setProviderStatusError(false);
    void api
      .getProviderStatus()
      .then(setProviderStatus)
      .catch(() => setProviderStatusError(true));
  }, [api]);

  const createSession = useCallback(
    async (prompt?: string) => {
      if (!api || !workspace || isCreating) return;
      setIsCreating(true);
      setSessionError(null);
      try {
        const createdReference = await api.createSession({ workspaceId: workspace.id, mode, permissionMode });
        const now = new Date().toISOString();
        const created: Session = {
          id: createdReference.id,
          title: null,
          cwd: null,
          pathLabel: workspace.pathLabel,
          workspaceId: workspace.id,
          mode,
          permissionMode,
          model: providerStatus?.selectedModel ?? null,
          revision: 0,
          messageCount: 0,
          latestUserPromptPreview: null,
          createdAt: now,
          updatedAt: now,
        };
        setSessions((current) => [created, ...current.filter((session) => session.id !== created.id)]);
        setActiveSession(created);
        safeSessionStorage().setItem(activeSessionStorageKey, created.id);
        if (prompt?.trim()) setInitialPrompt({ sessionId: created.id, text: prompt.trim() });
      } catch (cause) {
        setSessionError(cause instanceof Error ? cause.message : "Unable to create a session.");
      } finally {
        setIsCreating(false);
      }
    },
    [api, isCreating, mode, permissionMode, providerStatus?.selectedModel, workspace],
  );

  function openProjectBrowser() {
    projectBrowserTriggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIsBrowserOpen(true);
  }

  function restoreProjectBrowserFocus() {
    const trigger = projectBrowserTriggerRef.current;
    projectBrowserTriggerRef.current = null;
    window.requestAnimationFrame(() => {
      const fallback = document.querySelector<HTMLElement>(".workspace-path, .session-item");
      const focusTarget = trigger?.isConnected && !trigger.closest("[inert]") ? trigger : fallback;
      focusTarget?.focus();
    });
  }

  function closeProjectBrowser() {
    setIsBrowserOpen(false);
    restoreProjectBrowserFocus();
  }

  function openRail() {
    railTriggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIsRailOpen(true);
  }

  function closeRail({ restoreFocus = true } = {}) {
    setIsRailOpen(false);
    const trigger = railTriggerRef.current;
    railTriggerRef.current = null;
    if (restoreFocus) {
      window.requestAnimationFrame(() => trigger?.focus());
    }
  }

  const beginNewSession = useCallback(() => {
    if (!workspace) {
      projectBrowserTriggerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setIsBrowserOpen(true);
      return;
    }

    setActiveSession(null);
    setInitialPrompt(null);
    setMode(newSessionMode);
    setPermissionMode(newSessionPermissionMode);
    setIsRailOpen(false);
    railTriggerRef.current = null;
    try {
      safeSessionStorage().removeItem(activeSessionStorageKey);
    } catch {
      // The new-session surface remains available without storage.
    }
  }, [workspace]);

  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        beginNewSession();
      }
      if (event.key === "Escape" && isRailOpen) closeRail();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [beginNewSession, isRailOpen]);

  function selectWorkspace(selected: Workspace) {
    setWorkspace(selected);
    setActiveSession(null);
    setInitialPrompt(null);
    setMode(newSessionMode);
    setPermissionMode(newSessionPermissionMode);
    setIsBrowserOpen(false);
    setIsRailOpen(false);
    restoreProjectBrowserFocus();
    try {
      storeWorkspace(safeSessionStorage(), selected);
      safeSessionStorage().removeItem(activeSessionStorageKey);
    } catch {
      // The current tab can continue even when storage is unavailable.
    }
  }

  function selectSession(session: Session) {
    setActiveSession(session);
    setInitialPrompt(null);
    setMode(session.mode);
    setPermissionMode(session.permissionMode ?? "read-only");
    closeRail();
    try {
      safeSessionStorage().setItem(activeSessionStorageKey, session.id);
    } catch {
      // Session remains selected for this render.
    }
  }

  const applyPermissionModeLocally = useCallback((nextMode: PermissionMode) => {
    setPermissionMode(nextMode);
    setActiveSession((current) => current ? { ...current, permissionMode: nextMode } : current);
    setSessions((current) => current.map((entry) =>
      entry.id === activeSession?.id ? { ...entry, permissionMode: nextMode } : entry
    ));
  }, [activeSession?.id]);

  async function persistPermissionMode(nextMode: PermissionMode) {
    if (mode === "plan" && nextMode !== "read-only") return;
    if (!activeSession) {
      setPermissionMode(nextMode);
      return;
    }
    setSessionError(null);
    try {
      const updated = await api?.updateSessionPermission(activeSession.id, nextMode);
      if (!updated) return;
      applyPermissionModeLocally(nextMode);
    } catch (cause) {
      setSessionError(cause instanceof Error ? cause.message : "Unable to update permission mode.");
    }
  }

  if (!token || authorizationError) {
    return <AuthorizationGate detail={authorizationError} />;
  }

  if (!api) return null;

  return (
    <div className="app-shell">
      <SessionRail
        sessions={sessions}
        activeSessionId={activeSession?.id ?? null}
        workspace={workspace}
        isLoading={isLoadingSessions}
        error={sessionError}
        mobileOpen={isRailOpen}
        backgroundInert={isBrowserOpen}
        onCloseMobile={closeRail}
        onNewSession={beginNewSession}
        onOpenProject={openProjectBrowser}
        onSelectSession={selectSession}
      />

      <main className="workspace-main" inert={isRailOpen || isBrowserOpen ? true : undefined}>
        <WorkspaceRibbon
          workspace={workspace}
          session={activeSession}
          mode={mode}
          permissionMode={permissionMode}
          providerStatus={providerStatus}
          providerStatusError={providerStatusError}
          isRunning={isRunning}
          isCreating={isCreating}
          onOpenMenu={openRail}
          onOpenProject={openProjectBrowser}
          onModeChange={setMode}
          onPermissionModeChange={(nextMode) => void persistPermissionMode(nextMode)}
        />

        {activeSession ? (
          <ChatSurface
            key={activeSession.id}
            api={api}
            token={token}
            session={activeSession}
            workspace={workspace}
            mode={mode}
            permissionMode={permissionMode}
            providerStatus={providerStatus}
            sessions={sessions}
            initialPrompt={initialPrompt?.sessionId === activeSession.id ? initialPrompt.text : undefined}
            onRunStateChange={setIsRunning}
            onSessionUpdated={() => void loadSessions()}
            onNewSession={beginNewSession}
            onOpenSessions={openRail}
            onSelectSession={selectSession}
            onPermissionModeChange={applyPermissionModeLocally}
            onProviderStatusChange={setProviderStatus}
          />
        ) : (
          <NewSessionSurface
            api={api}
            workspace={workspace}
            sessions={sessions}
            mode={mode}
            permissionMode={permissionMode}
            providerStatus={providerStatus}
            isCreating={isCreating}
            error={sessionError}
            onChooseProject={openProjectBrowser}
            onNewSession={beginNewSession}
            onOpenSessions={openRail}
            onSelectSession={selectSession}
            onPermissionModeChange={applyPermissionModeLocally}
            onProviderStatusChange={setProviderStatus}
            onStart={(prompt) => void createSession(prompt)}
          />
        )}
      </main>

      {isBrowserOpen ? (
        <ProjectBrowser
          api={api}
          dismissible={Boolean(workspace || sessions.length)}
          onClose={closeProjectBrowser}
          onSelect={selectWorkspace}
        />
      ) : null}
    </div>
  );
}

function AuthorizationGate({ detail }: { detail?: string | null }) {
  return (
    <main className="authorization-gate">
      <div className="authorization-mark"><Icon name="shield" size={28} /></div>
      <h1>This browser is not connected to Lightcode.</h1>
      <p>{detail ?? "The launch token is missing or no longer valid."}</p>
      <pre><code>lightcode web</code></pre>
      <small>Run the command again and use the browser tab it opens. Tokens stay in this tab only.</small>
    </main>
  );
}

function NewSessionSurface({
  api,
  workspace,
  sessions,
  mode,
  permissionMode,
  providerStatus,
  isCreating,
  error,
  onChooseProject,
  onNewSession,
  onOpenSessions,
  onSelectSession,
  onPermissionModeChange,
  onProviderStatusChange,
  onStart,
}: {
  api: ReturnType<typeof createLightcodeApi>;
  workspace: Workspace | null;
  sessions: Session[];
  mode: CodingMode;
  permissionMode: PermissionMode;
  providerStatus: ProviderStatus | null;
  isCreating: boolean;
  error: string | null;
  onChooseProject: () => void;
  onNewSession: () => void;
  onOpenSessions: () => void;
  onSelectSession: (session: Session) => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
  onProviderStatusChange: (status: ProviderStatus) => void;
  onStart: (prompt: string) => void;
}) {
  const [commandResult, setCommandResult] = useState<CommandResult | null>(null);
  const [commandBusy, setCommandBusy] = useState<string | null>(null);

  async function runCommand(
    command: SlashCommandDefinition,
    args: string,
    available: boolean,
  ) {
    if (!available) {
      setCommandResult({
        title: `${command.command} needs a session`,
        detail: "Start or open a session, then run the command again.",
        tone: "error",
      });
      return;
    }
    setCommandResult(null);
    setCommandBusy(command.id);
    const next = await executeWebCommand(command.id, args, {
      api,
      messages: [],
      sessions,
      mode,
      permissionMode,
      providerStatus,
      isStreaming: false,
      onNewSession,
      onOpenSessions,
      onSelectSession,
      onPermissionModeChange,
      onProviderStatusChange,
    });
    setCommandBusy(null);
    setCommandResult(next);
  }

  return (
    <section className="new-session-surface">
      <div className="new-session-inner">
        <div className="new-session-title">
          <span className="new-session-mark"><Icon name="lightcode" size={25} /></span>
          <div>
            <h1>{workspace ? `New session in ${workspace.name}` : "Choose a project to begin"}</h1>
            <button type="button" onClick={onChooseProject}>
              <Icon name="folder-open" size={16} />
              {workspace?.pathLabel ?? "Browse local folders"}
              <Icon name="chevron-down" size={14} />
            </button>
          </div>
        </div>

        <CommandComposer
          appearance="starter"
          hasSession={false}
          canSendMessage={Boolean(workspace) && !isCreating}
          autoFocus={Boolean(workspace)}
          placeholder={workspace ? "What are you building? Type / for commands" : "Type / for commands, or choose a project first"}
          commandResult={commandResult}
          commandBusy={commandBusy}
          onDismissResult={() => setCommandResult(null)}
          onSubmit={(text) => {
            setCommandResult(null);
            onStart(text);
          }}
          onCommand={(command, args, available) => void runCommand(command, args, available)}
          onUnknownCommand={(invokedAs) => setCommandResult({
            title: `Unknown command ${invokedAs}`,
            detail: "Type / to see every available command.",
            tone: "error",
          })}
        />
        {error ? <div className="new-session-error" role="alert"><Icon name="warning" size={16} />{error}</div> : null}
        <div className="starter-suggestions" aria-label="Suggested prompts">
          {["Explain this project", "Find the highest-risk issue", "Plan the next change"].map((suggestion) => (
            <button key={suggestion} type="button" disabled={!workspace || isCreating} onClick={() => onStart(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
