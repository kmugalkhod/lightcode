import { useEffect, useRef, useState } from "react";
import type { Session, Workspace } from "../lib/api";
import { displaySessionTitle, formatRelativeTime } from "../lib/api";
import { shortcutLabel } from "../lib/client-platform";
import { Icon } from "./icons";

interface SessionRailProps {
  sessions: Session[];
  activeSessionId: string | null;
  workspace: Workspace | null;
  isLoading: boolean;
  isPickingProject: boolean;
  isRunning: boolean;
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
  isRunning,
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
            <span className="brand-mark"><Icon name="lightcode" size={16} /></span>
            <span>Lightcode</span>
          </div>
          <button ref={mobileCloseRef} className="icon-button mobile-only" type="button" onClick={onCloseMobile} aria-label="Close sessions">
            <Icon name="x" />
          </button>
        </header>

        <nav className="rail-nav" aria-label="Workspace">
          <button className="rail-nav-item" type="button" onClick={onNewSession} disabled={!workspace}>
            <Icon name="plus" size={16} />
            <span>New session</span>
            <kbd>{shortcutLabel({ shift: true, key: "N" })}</kbd>
          </button>
          <label className="rail-nav-item session-search">
            <Icon name="search" size={16} />
            <input id="session-search" type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search" aria-label="Search sessions" />
            <kbd>{shortcutLabel({ key: "K" })}</kbd>
          </label>
          <button
            className="rail-nav-item project-button"
            type="button"
            title={workspace?.hostPath ?? workspace?.pathLabel}
            onClick={onOpenProject}
            disabled={isPickingProject}
            aria-busy={isPickingProject}
          >
            {isPickingProject ? (
              <span className="inline-spinner" aria-hidden="true" />
            ) : (
              <Icon name="folder" size={16} />
            )}
            <span className="project-button-label">
              {isPickingProject
                ? "Opening folder picker"
                : workspace?.name ?? "Open project"}
            </span>
          </button>
        </nav>

        <div className="rail-section-heading">
          <span>Recent</span>
          {query ? <span>{filteredSessions.length}</span> : null}
        </div>
        <nav className="session-list" aria-label="Saved conversations">
          {isLoading ? <SessionSkeleton /> : null}
          {!isLoading && error ? (
            <div className="rail-state">
              <Icon name="warning" size={16} />
              <p>{error}</p>
              <button type="button" onClick={onRetry}>Retry</button>
            </div>
          ) : null}
          {!isLoading && !error && sessions.length === 0 ? (
            <div className="rail-state">
              <p>No sessions yet.</p>
            </div>
          ) : null}
          {!isLoading && !error
            ? filteredSessions.map((session) => {
                const active = activeSessionId === session.id;
                const project = (session.pathLabel ?? session.cwd)?.replaceAll("\\", "/").split("/").filter(Boolean).at(-1);
                return (
                  <button
                    className={active ? "session-item active" : "session-item"}
                    key={session.id}
                    type="button"
                    title={[displaySessionTitle(session), project, formatRelativeTime(session.updatedAt)].filter(Boolean).join(" · ")}
                    onClick={() => onSelectSession(session)}
                    aria-current={active ? "page" : undefined}
                  >
                    {active && isRunning ? (
                      <span className="session-spinner" aria-label="Working" />
                    ) : (
                      <span className="session-marker" aria-hidden="true" />
                    )}
                    <span className="session-title">{displaySessionTitle(session)}</span>
                  </button>
                );
              })
            : null}
          {!isLoading && !error && query && filteredSessions.length === 0 ? <div className="rail-state"><p>No matching sessions.</p></div> : null}
        </nav>
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
