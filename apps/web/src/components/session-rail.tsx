import { useEffect, useRef, useState } from "react";
import type { Session, Workspace } from "../lib/api";
import { displaySessionTitle, formatRelativeTime } from "../lib/api";
import { Icon } from "./icons";

interface SessionRailProps {
  sessions: Session[];
  activeSessionId: string | null;
  workspace: Workspace | null;
  isLoading: boolean;
  isPickingProject: boolean;
  error: string | null;
  mobileOpen: boolean;
  backgroundInert: boolean;
  onCloseMobile: () => void;
  onNewSession: () => void;
  onOpenProject: () => void;
  onSelectSession: (session: Session) => void;
  onRetry: () => void;
}

export function SessionRail({
  sessions,
  activeSessionId,
  workspace,
  isLoading,
  isPickingProject,
  error,
  mobileOpen,
  backgroundInert,
  onCloseMobile,
  onNewSession,
  onOpenProject,
  onSelectSession,
  onRetry,
}: SessionRailProps) {
  const mobileCloseRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const filteredSessions = sessions.filter((session) => `${displaySessionTitle(session)} ${session.pathLabel ?? session.cwd ?? ""}`.toLowerCase().includes(query.toLowerCase().trim()));

  useEffect(() => {
    if (mobileOpen) {
      mobileCloseRef.current?.focus();
    }
  }, [mobileOpen]);

  return (
    <>
      {mobileOpen ? (
        <button
          className="rail-scrim"
          type="button"
          aria-label="Close sessions"
          onClick={onCloseMobile}
        />
      ) : null}
      <aside
        className={mobileOpen ? "session-rail open" : "session-rail"}
        aria-label="Lightcode sessions"
        role={mobileOpen ? "dialog" : undefined}
        aria-modal={mobileOpen ? true : undefined}
        inert={backgroundInert ? true : undefined}
        onKeyDown={(event) => {
          if (!mobileOpen || event.key !== "Tab") return;
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')).filter((item) => item.getClientRects().length);
          const first = items[0];
          const last = items.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
      >
        <header className="rail-header">
          <div className="brand-lockup">
            <span className="brand-mark"><Icon name="lightcode" size={17} /></span>
            <span>Lightcode</span>
          </div>
          <button ref={mobileCloseRef} className="icon-button mobile-only" type="button" onClick={onCloseMobile} aria-label="Close sessions">
            <Icon name="x" />
          </button>
        </header>

        <div className="rail-actions">
          <button className="new-session-button" type="button" onClick={onNewSession} disabled={!workspace}>
            <Icon name="plus" size={16} />
            New session
            <kbd title="Control or Command + Shift + N">⇧ N</kbd>
          </button>
          <button
            className="project-button"
            type="button"
            onClick={onOpenProject}
            disabled={isPickingProject}
            aria-busy={isPickingProject}
          >
            {isPickingProject ? (
              <span className="inline-spinner" aria-hidden="true" />
            ) : (
              <Icon name="folder-open" size={16} />
            )}
            <span className="project-button-label">
              {isPickingProject
                ? "Opening folder picker"
                : workspace?.name ?? "Choose project"}
            </span>
            <Icon name="chevron-right" size={15} />
          </button>
        </div>

        <label className="session-search">
          <Icon name="search" size={16} />
          <input id="session-search" type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Find a session…" aria-label="Search sessions" />
          <kbd>⌘ K</kbd>
        </label>

        <div className="rail-section-heading">
          <span>Sessions</span>
          <span>{query ? `${filteredSessions.length} / ` : ""}{sessions.length}</span>
        </div>
        <nav className="session-list" aria-label="Saved conversations">
          {isLoading ? <SessionSkeleton /> : null}
          {!isLoading && error ? (
            <div className="rail-state">
              <Icon name="warning" size={18} />
              <p>{error}</p>
              <button type="button" onClick={onRetry}>Retry</button>
            </div>
          ) : null}
          {!isLoading && !error && sessions.length === 0 ? (
            <div className="rail-state">
              <Icon name="message" size={18} />
              <p>No sessions yet. Start one in this project.</p>
            </div>
          ) : null}
          {!isLoading && !error
            ? filteredSessions.map((session) => (
                <button
                  className={activeSessionId === session.id ? "session-item active" : "session-item"}
                  key={session.id}
                  type="button"
                  onClick={() => onSelectSession(session)}
                  aria-current={activeSessionId === session.id ? "page" : undefined}
                >
                  <span className="session-marker" />
                  <span className="session-copy">
                    <strong>{displaySessionTitle(session)}</strong>
                    <small>
                      {(session.pathLabel ?? session.cwd)?.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? (session.mode === "plan" ? "Plan" : "Build")}
                      <span aria-hidden="true"> · </span>
                      {formatRelativeTime(session.updatedAt)}
                    </small>
                  </span>
                </button>
              ))
            : null}
          {!isLoading && !error && query && filteredSessions.length === 0 ? <div className="rail-state"><p>No matching sessions. Try a title or project name.</p></div> : null}
        </nav>
        <footer className="rail-footer"><Icon name="terminal" size={16} /><span>One workspace. Web & terminal.<small>Your conversations stay together.</small></span></footer>
      </aside>
    </>
  );
}

function SessionSkeleton() {
  return (
    <div className="session-skeleton" aria-label="Loading sessions">
      {Array.from({ length: 4 }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  );
}
