import { useEffect, useRef } from "react";
import type { Session, Workspace } from "../lib/api";
import { displaySessionTitle, formatRelativeTime } from "../lib/api";
import { Icon } from "./icons";

interface SessionRailProps {
  sessions: Session[];
  activeSessionId: string | null;
  workspace: Workspace | null;
  isLoading: boolean;
  error: string | null;
  mobileOpen: boolean;
  backgroundInert: boolean;
  onCloseMobile: () => void;
  onNewSession: () => void;
  onOpenProject: () => void;
  onSelectSession: (session: Session) => void;
}

const laterItems = [
  ["agent", "Agents"],
  ["spark", "Skills"],
  ["instructions", "Instructions"],
  ["mcp", "MCP servers"],
  ["tool", "Tools"],
] as const;

export function SessionRail({
  sessions,
  activeSessionId,
  workspace,
  isLoading,
  error,
  mobileOpen,
  backgroundInert,
  onCloseMobile,
  onNewSession,
  onOpenProject,
  onSelectSession,
}: SessionRailProps) {
  const mobileCloseRef = useRef<HTMLButtonElement>(null);

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
        inert={backgroundInert ? true : undefined}
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
            <kbd>⌘N</kbd>
          </button>
          <button className="project-button" type="button" onClick={onOpenProject}>
            <Icon name="folder-open" size={16} />
            <span>{workspace?.name ?? "Choose project"}</span>
            <Icon name="chevron-right" size={15} />
          </button>
        </div>

        <div className="rail-section-heading">
          <span>Sessions</span>
          <span>{sessions.length}</span>
        </div>
        <nav className="session-list" aria-label="Saved conversations">
          {isLoading ? <SessionSkeleton /> : null}
          {!isLoading && error ? (
            <div className="rail-state">
              <Icon name="warning" size={18} />
              <p>{error}</p>
            </div>
          ) : null}
          {!isLoading && !error && sessions.length === 0 ? (
            <div className="rail-state">
              <Icon name="message" size={18} />
              <p>No sessions yet. Start one in this project.</p>
            </div>
          ) : null}
          {!isLoading && !error
            ? sessions.map((session) => (
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
                      {session.mode === "plan" ? "Plan" : "Build"}
                      <span aria-hidden="true"> · </span>
                      {formatRelativeTime(session.updatedAt)}
                    </small>
                  </span>
                </button>
              ))
            : null}
        </nav>

        <footer className="rail-footer">
          <div className="rail-section-heading"><span>Customize</span><span>Later</span></div>
          {laterItems.map(([icon, label]) => (
            <button className="later-item" type="button" key={label} disabled title={`${label} are coming to the browser later`}>
              <Icon name={icon} size={16} />
              <span>{label}</span>
              <small>CLI</small>
            </button>
          ))}
        </footer>
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
