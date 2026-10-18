import { useEffect, useRef, useState } from "react";
import type { RecentProject, Session, Workspace } from "../lib/api";
import { displaySessionTitle, formatRelativeTime } from "../lib/api";
import { shortcutLabel } from "../lib/client-platform";
import { Icon } from "./icons";

export interface SessionGroup {
  key: string;
  name: string;
  path: string | null;
  sessions: Session[];
}

const collapsedGroupsStorageKey = "lightcode.web.collapsedProjects";
/** Sessions shown per project before the rest fold behind "Show more". */
export const sessionsPerGroup = 5;

function normalizeProjectPath(path: string | null | undefined): string {
  if (!path) return "";
  const slashed = path.replaceAll("\\", "/").replace(/\/+$/, "");
  // Windows paths are case-insensitive; keep POSIX paths exact.
  return /^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed;
}

/** The recent project a session ran in, when the server still lists it as openable. */
export function recentProjectForSession(session: Session | null, projects: readonly RecentProject[]): RecentProject | null {
  const key = normalizeProjectPath(session?.cwd);
  if (!key) return null;
  return projects.find((project) => project.available && normalizeProjectPath(project.pathLabel) === key) ?? null;
}

function projectName(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

/**
 * Buckets sessions by the folder they ran in. The open project leads, the
 * rest follow by their most recent activity; sessions stay newest first.
 */
export function groupSessionsByProject(sessions: Session[], workspace: Workspace | null): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const session of sessions) {
    const path = session.cwd ?? session.pathLabel ?? null;
    const key = normalizeProjectPath(path);
    let group = groups.get(key);
    if (!group) {
      group = { key, name: path ? projectName(path) : "Other", path, sessions: [] };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }
  const currentKey = normalizeProjectPath(workspace?.hostPath ?? workspace?.pathLabel);
  const latest = (group: SessionGroup) => group.sessions.reduce((max, session) => (session.updatedAt > max ? session.updatedAt : max), "");
  for (const group of groups.values()) {
    group.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return [...groups.values()].sort((a, b) => {
    if (currentKey && a.key === currentKey) return -1;
    if (currentKey && b.key === currentKey) return 1;
    if (!a.key !== !b.key) return a.key ? -1 : 1;
    return latest(b).localeCompare(latest(a));
  });
}

function readCollapsedGroups(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(collapsedGroupsStorageKey) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function writeCollapsedGroups(keys: Set<string>) {
  try {
    window.localStorage.setItem(collapsedGroupsStorageKey, JSON.stringify([...keys]));
  } catch {
    // Collapsed state is a convenience; it resets when storage is unavailable.
  }
}

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
  const [collapsed, setCollapsed] = useState(readCollapsedGroups);
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(() => new Set());
  const filteredSessions = sessions.filter((session) => `${displaySessionTitle(session)} ${session.pathLabel ?? session.cwd ?? ""}`.toLowerCase().includes(query.toLowerCase().trim()));
  const groups = groupSessionsByProject(filteredSessions, workspace);
  const searching = query.trim().length > 0;

  function toggleGroup(key: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeCollapsedGroups(next);
      return next;
    });
  }

  function toggleShowAll(key: string) {
    setShowAll((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

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
          <button className="rail-nav-item" type="button" onClick={onNewSession}>
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
          <span>Projects</span>
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
            ? groups.map((group) => {
                // Searching shows every match; a collapsed project keeps its active session visible.
                const isCollapsed = !searching && collapsed.has(group.key);
                const expandedFully = searching || showAll.has(group.key);
                const visible = isCollapsed
                  ? group.sessions.filter((session) => session.id === activeSessionId)
                  : expandedFully
                    ? group.sessions
                    : group.sessions.filter((session, index) => index < sessionsPerGroup || session.id === activeSessionId);
                const hiddenCount = group.sessions.length - visible.length;
                const listId = `session-group-${group.key || "other"}`;
                return (
                  <section className={isCollapsed ? "session-group collapsed" : "session-group"} key={group.key}>
                    <button
                      className="session-group-header"
                      type="button"
                      title={group.path ?? undefined}
                      onClick={() => toggleGroup(group.key)}
                      aria-expanded={!isCollapsed}
                      aria-controls={listId}
                      disabled={searching}
                    >
                      <span className="session-group-icon" aria-hidden="true">
                        <Icon name="folder" size={14} />
                        <Icon name="chevron-right" size={13} />
                      </span>
                      <span className="session-group-name">{group.name}</span>
                      <span className="session-group-count">{group.sessions.length}</span>
                    </button>
                    <div className="session-group-items" id={listId}>
                      {visible.map((session) => {
                        const active = activeSessionId === session.id;
                        return (
                          <button
                            className={active ? "session-item active" : "session-item"}
                            key={session.id}
                            type="button"
                            title={[displaySessionTitle(session), formatRelativeTime(session.updatedAt)].join(" · ")}
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
                      })}
                      {!isCollapsed && !searching && (hiddenCount > 0 || showAll.has(group.key)) ? (
                        <button className="session-group-more" type="button" onClick={() => toggleShowAll(group.key)}>
                          {hiddenCount > 0 ? `Show ${hiddenCount} more` : "Show less"}
                        </button>
                      ) : null}
                    </div>
                  </section>
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
