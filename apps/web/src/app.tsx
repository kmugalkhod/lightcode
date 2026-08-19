import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChatSurface } from "./components/chat-surface";
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
        const loaded = await api.loadSession(createdReference.id);
        if (!loaded.session) {
          throw new Error("Lightcode created the session but could not load it.");
        }
        const created = loaded.session;
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
    [api, isCreating, mode, permissionMode, workspace],
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
          onPermissionModeChange={setPermissionMode}
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
            initialPrompt={initialPrompt?.sessionId === activeSession.id ? initialPrompt.text : undefined}
            onRunStateChange={setIsRunning}
            onSessionUpdated={() => void loadSessions()}
          />
        ) : (
          <NewSessionSurface
            workspace={workspace}
            isCreating={isCreating}
            error={sessionError}
            onChooseProject={openProjectBrowser}
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
  workspace,
  isCreating,
  error,
  onChooseProject,
  onStart,
}: {
  workspace: Workspace | null;
  isCreating: boolean;
  error: string | null;
  onChooseProject: () => void;
  onStart: (prompt: string) => void;
}) {
  const [value, setValue] = useState("");

  function send() {
    if (!workspace || !value.trim() || isCreating) return;
    onStart(value.trim());
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
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

        <div className="starter-composer">
          <textarea
            value={value}
            rows={3}
            disabled={!workspace || isCreating}
            aria-label="First message to Lightcode"
            placeholder={workspace ? "What are you building?" : "Choose a project first"}
            onChange={(event) => setValue(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            autoFocus={Boolean(workspace)}
          />
          <div className="starter-toolbar">
            <span><Icon name="agent" size={16} />Agent</span>
            <button className="send-button" type="button" onClick={send} disabled={!workspace || !value.trim() || isCreating} aria-label="Create session and send">
              {isCreating ? <span className="button-loading" /> : <Icon name="arrow-up" size={17} />}
            </button>
          </div>
        </div>
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
