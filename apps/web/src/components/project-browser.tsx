import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BrowserEntry,
  LightcodeApi,
  RecentProject,
  Workspace,
  WorkspaceLocation,
} from "../lib/api";
import { LightcodeApiError, requiresBroadWorkspaceConfirmation } from "../lib/api";
import {
  broadWorkspaceRootWarning,
  isDrivesLocation,
  isSelectableBrowserPath,
  workspaceLocationName,
  workspaceLocationPath,
} from "../lib/workspace-location";
import {
  createExclusiveRequestGate,
  type ExclusiveRequestGate,
} from "../lib/exclusive-request-gate";
import { Icon, type IconName } from "./icons";

interface ProjectBrowserProps {
  api: LightcodeApi;
  dismissible: boolean;
  nativePickerPending: boolean;
  notice: ProjectBrowserNotice | null;
  onClose: () => void;
  onSelect: (workspace: Workspace) => void;
  recentProjects: RecentProject[];
  onOpenRecent: (project: RecentProject) => void;
  /** Button label for the OS folder dialog ("Use Windows dialog"); null hides it. */
  systemPickerLabel: string | null;
  onUseSystemPicker: () => void;
  onCancelSystemPicker: () => void;
  /** Narrow screens: full-screen, with the places sidebar as a scrolling strip. */
  compact: boolean;
}

export interface ProjectBrowserNotice {
  tone: "info" | "error";
  title: string;
  detail: string;
  retryable: boolean;
  /** Primary recovery action shown before the retry button. */
  action?: { label: string; onSelect: () => void };
}

interface BrowserState {
  browserId: string;
  location: WorkspaceLocation;
  segments: string[];
  pathLabel: string;
  entries: BrowserEntry[];
  nextCursor: string | null;
}

type BrowserErrorKind = "auth" | "os-permission" | "other";

type BrowserRetry =
  | { kind: "locations" }
  | { kind: "open"; location: WorkspaceLocation }
  | {
      kind: "directory";
      browserId: string;
      location: WorkspaceLocation;
      segments: string[];
      append?: boolean;
      cursor?: string;
    }
  | { kind: "select"; segments: string[] };

/**
 * Locations the server reported as absent stay muted for the rest of the page
 * session instead of offering a Retry that cannot succeed.
 */
const missingLocations = new Map<string, string>();

const locationIcons: Record<string, IconName> = {
  desktop: "desktop",
  home: "home",
  documents: "document",
  downloads: "download",
  projects: "folder",
  drives: "drive",
};

function locationIcon(location: WorkspaceLocation): IconName {
  return locationIcons[location.id] ?? "folder";
}

function apiErrorCode(cause: unknown): string | null {
  if (!(cause instanceof LightcodeApiError)) return null;
  const code =
    cause.payload && typeof cause.payload === "object"
      ? Reflect.get(cause.payload, "code")
      : null;
  return typeof code === "string" ? code : null;
}

function classifyBrowserError(cause: unknown): BrowserErrorKind {
  if (!(cause instanceof LightcodeApiError)) return "other";
  const code = apiErrorCode(cause);
  if (code === "os_permission_denied") return "os-permission";
  if (cause.status === 401 || (typeof code === "string" && code.startsWith("web_auth_"))) {
    return "auth";
  }
  return "other";
}

/**
 * The project chooser: a file-browser window with places on the left, an
 * address bar with a filter, and the folders of the current location. Opening
 * a location is always an explicit click; the home view lists only labels.
 */
export function ProjectBrowser({
  api,
  dismissible,
  nativePickerPending,
  notice,
  onClose,
  onSelect,
  recentProjects,
  onOpenRecent,
  systemPickerLabel,
  onUseSystemPicker,
  onCancelSystemPicker,
  compact,
}: ProjectBrowserProps) {
  const [locations, setLocations] = useState<WorkspaceLocation[]>([]);
  const [browser, setBrowser] = useState<BrowserState | null>(null);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [filter, setFilter] = useState("");
  const [, setMissingRevision] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingLabel, setLoadingLabel] = useState("Loading places");
  const [isSelecting, setIsSelecting] = useState(false);
  const [confirmBroadRoot, setConfirmBroadRoot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<BrowserErrorKind>("other");
  const [retry, setRetry] = useState<BrowserRetry | null>(null);
  const [openingLocationId, setOpeningLocationId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const requestGateRef = useRef<ExclusiveRequestGate | null>(null);
  if (!requestGateRef.current) {
    requestGateRef.current = createExclusiveRequestGate();
  }
  const requestGate = requestGateRef.current;

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGate.invalidate();
    };
  }, [requestGate]);

  const loadDirectory = useCallback(
    async ({
      browserId,
      location,
      segments,
      append = false,
      cursor,
      includeHiddenValue,
      showFilesValue,
      loadingMessage,
      requestId,
    }: {
      browserId: string;
      location: WorkspaceLocation;
      segments: string[];
      append?: boolean;
      cursor?: string;
      includeHiddenValue?: boolean;
      showFilesValue?: boolean;
      loadingMessage?: string;
      requestId?: number;
    }) => {
      const ownsRequest = requestId === undefined;
      const activeRequestId = requestId ?? requestGate.tryStart();
      if (activeRequestId === null || !requestGate.isCurrent(activeRequestId)) return;

      setConfirmBroadRoot(false);
      setIsLoading(true);
      setLoadingLabel(
        loadingMessage ??
          (append
            ? "Loading more folders"
            : `Opening ${segments.at(-1) ?? workspaceLocationName(location)}`),
      );
      setError(null);
      setRetry(null);
      try {
        const page = await api.listEntries({
          browserId,
          segments,
          cursor,
          includeHidden: includeHiddenValue ?? includeHidden,
          directoriesOnly: !(showFilesValue ?? showFiles),
        });
        if (!requestGate.isCurrent(activeRequestId)) return;
        if (!append) setFilter("");
        setBrowser((current) => ({
          browserId,
          location,
          segments: page.segments,
          pathLabel:
            page.pathLabel ??
            workspaceLocationPath(location, page.segments),
          entries: append ? [...(current?.entries ?? []), ...page.entries] : page.entries,
          nextCursor: page.nextCursor,
        }));
      } catch (cause) {
        if (!requestGate.isCurrent(activeRequestId)) return;
        setErrorKind(classifyBrowserError(cause));
        setError(cause instanceof Error ? cause.message : "Unable to open this folder.");
        setRetry({
          kind: "directory",
          browserId,
          location,
          segments,
          append,
          cursor,
        });
      } finally {
        if (ownsRequest && requestGate.finish(activeRequestId) && mountedRef.current) {
          setIsLoading(false);
        }
      }
    },
    [api, includeHidden, showFiles, requestGate],
  );

  const openLocation = useCallback(
    async (location: WorkspaceLocation) => {
      const requestId = requestGate.tryStart();
      if (requestId === null) return;

      setConfirmBroadRoot(false);
      setIsLoading(true);
      setLoadingLabel(`Opening ${workspaceLocationName(location)}`);
      setError(null);
      setRetry(null);
      setOpeningLocationId(location.id);
      try {
        const opened = await api.openLocation(location.id);
        if (!requestGate.isCurrent(requestId)) return;
        missingLocations.delete(location.id);
        await loadDirectory({
          browserId: opened.browserId,
          location: opened.location ?? location,
          segments: [],
          requestId,
        });
      } catch (cause) {
        if (!requestGate.isCurrent(requestId)) return;
        setErrorKind(classifyBrowserError(cause));
        const message =
          cause instanceof Error ? cause.message : "Unable to open this location.";
        setError(message);
        if (apiErrorCode(cause) === "location_missing") {
          // Retrying cannot create the folder; mute the location instead.
          missingLocations.set(location.id, message);
          setMissingRevision((revision) => revision + 1);
          setBrowser(null);
        } else {
          setRetry({ kind: "open", location });
        }
      } finally {
        if (requestGate.finish(requestId) && mountedRef.current) {
          setIsLoading(false);
          setOpeningLocationId(null);
        }
      }
    },
    [api, loadDirectory, requestGate],
  );

  const loadLocations = useCallback(async (requestId?: number) => {
    const activeRequestId = requestId ?? requestGate.tryStart();
    if (activeRequestId === null || !requestGate.isCurrent(activeRequestId)) return;

    setConfirmBroadRoot(false);
    setIsLoading(true);
    setLoadingLabel("Loading places");
    setError(null);
    setRetry(null);
    try {
      const available = await api.listLocations();
      if (!requestGate.isCurrent(activeRequestId)) return;
      setLocations(available);
      if (available.length === 0) {
        setErrorKind("other");
        setError("No local folders are available. Check that your user folders exist, then retry.");
        setRetry({ kind: "locations" });
      }
    } catch (cause) {
      if (!requestGate.isCurrent(activeRequestId)) return;
      setErrorKind(classifyBrowserError(cause));
      setError(cause instanceof Error ? cause.message : "Unable to list local folders.");
      setRetry({ kind: "locations" });
    } finally {
      if (requestGate.finish(activeRequestId) && mountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [api, requestGate]);

  useEffect(() => {
    const requestId = requestGate.tryStart();
    if (requestId !== null) {
      void loadLocations(requestId);
    }
    return () => {
      if (requestId !== null) requestGate.invalidate(requestId);
    };
    // Listing safe location labels does not touch their folders. Opening the actual
    // browser capability must remain behind an explicit click.
  }, [loadLocations, requestGate]);

  const filterText = filter.trim().toLowerCase();
  const visibleEntries = useMemo(() => {
    const entries = browser?.entries ?? [];
    return filterText
      ? entries.filter((entry) => entry.name.toLowerCase().includes(filterText))
      : entries;
  }, [browser?.entries, filterText]);
  const directoryEntries = visibleEntries.filter((entry) => entry.kind === "directory");
  const fileEntries = visibleEntries.filter((entry) => entry.kind !== "directory");

  async function chooseFolder(segments: string[]) {
    if (!browser || requestGate.isBusy()) return;
    if (!isSelectableBrowserPath(browser.location, segments)) return;
    if (requiresBroadWorkspaceConfirmation(segments) && !confirmBroadRoot) {
      setConfirmBroadRoot(true);
      return;
    }

    const requestId = requestGate.tryStart();
    if (requestId === null) return;
    setIsSelecting(true);
    setError(null);
    setRetry(null);
    try {
      const workspace = await api.selectWorkspace(browser.browserId, segments);
      if (requestGate.isCurrent(requestId) && mountedRef.current) {
        onSelect(workspace);
      }
    } catch (cause) {
      if (!requestGate.isCurrent(requestId)) return;
      setErrorKind(classifyBrowserError(cause));
      setError(cause instanceof Error ? cause.message : "Unable to select this project.");
      setRetry({ kind: "select", segments });
    } finally {
      if (requestGate.finish(requestId) && mountedRef.current) {
        setIsSelecting(false);
      }
    }
  }

  function enterDirectory(entry: BrowserEntry) {
    if (!browser || !entry.selectable || requestGate.isBusy()) return;
    void loadDirectory({
      browserId: browser.browserId,
      location: browser.location,
      segments: [...browser.segments, entry.name],
      loadingMessage: `Opening ${entry.name}`,
    });
  }

  function goToSegment(index: number) {
    if (!browser || requestGate.isBusy()) return;
    void loadDirectory({
      browserId: browser.browserId,
      location: browser.location,
      segments: browser.segments.slice(0, index),
      loadingMessage:
        index === 0
          ? `Opening ${workspaceLocationName(browser.location)}`
          : `Opening ${browser.segments[index - 1] ?? "folder"}`,
    });
  }

  function goHome() {
    if (requestGate.isBusy()) return;
    setBrowser(null);
    setFilter("");
    setError(null);
    setRetry(null);
    setConfirmBroadRoot(false);
  }

  function goUp() {
    if (!browser) return;
    if (browser.segments.length === 0) goHome();
    else goToSegment(browser.segments.length - 1);
  }

  function setHiddenFolders(nextIncludeHidden: boolean) {
    if (requestGate.isBusy()) return;
    setIncludeHidden(nextIncludeHidden);
    if (!browser) return;

    void loadDirectory({
      browserId: browser.browserId,
      location: browser.location,
      segments: browser.segments,
      includeHiddenValue: nextIncludeHidden,
      loadingMessage: "Updating folders",
    });
  }

  function setFileVisibility(nextShowFiles: boolean) {
    if (requestGate.isBusy()) return;
    setShowFiles(nextShowFiles);
    if (!browser) return;

    void loadDirectory({
      browserId: browser.browserId,
      location: browser.location,
      segments: browser.segments,
      showFilesValue: nextShowFiles,
      loadingMessage: "Updating folders",
    });
  }

  function retryBrowserOperation() {
    if (!retry || requestGate.isBusy()) return;
    if (retry.kind === "locations") {
      void loadLocations();
    } else if (retry.kind === "open") {
      void openLocation(retry.location);
    } else if (retry.kind === "directory") {
      void loadDirectory(retry);
    } else {
      void chooseFolder(retry.segments);
    }
  }

  const interactionsLocked = isLoading || isSelecting || nativePickerPending;
  const activeLocationId = openingLocationId ?? browser?.location.id ?? null;
  const places = locations.filter((location) => !isDrivesLocation(location));
  const drives = locations.find(isDrivesLocation) ?? null;
  const sidebarRecents = recentProjects.filter((project) => project.available).slice(0, 5);
  const failedLocation =
    retry?.kind === "open" || retry?.kind === "directory"
      ? retry.location
      : browser?.location ?? null;
  const failedLocationName = failedLocation
    ? workspaceLocationName(failedLocation)
    : "this local folder";
  const currentLocationName = browser
    ? workspaceLocationName(browser.location)
    : "this location";
  const canSelectCurrent = browser
    ? isSelectableBrowserPath(browser.location, browser.segments)
    : false;
  const errorHeading =
    errorKind === "os-permission"
      ? "Your system blocked folder access"
      : errorKind === "auth"
        ? "This browser launch expired"
        : retry?.kind === "locations"
          ? "Local folders could not be listed"
          : retry?.kind === "select"
            ? "This project could not be selected"
            : "This folder could not be opened";

  function placeButton(location: WorkspaceLocation) {
    const missing = missingLocations.get(location.id);
    const active = activeLocationId === location.id;
    return (
      <button
        key={location.id}
        className={["pb-side-item", active ? "active" : "", missing ? "missing" : ""]
          .filter(Boolean)
          .join(" ")}
        type="button"
        aria-current={active ? "location" : undefined}
        aria-label={
          missing
            ? `${workspaceLocationName(location)} (not found)`
            : `Open ${workspaceLocationName(location)}`
        }
        title={missing ?? location.pathLabel}
        disabled={interactionsLocked}
        onClick={() => void openLocation(location)}
      >
        <Icon name={locationIcon(location)} size={16} />
        <span>{workspaceLocationName(location)}</span>
      </button>
    );
  }

  return (
    <div
      className={compact ? "project-browser-backdrop compact" : "project-browser-backdrop"}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && dismissible && !nativePickerPending) {
          onClose();
        }
      }}
    >
      <section
        ref={dialogRef}
        className="project-browser"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-browser-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape" && dismissible && !nativePickerPending) {
            event.stopPropagation();
            onClose();
            return;
          }
          const typing =
            event.target instanceof HTMLInputElement && event.target.type === "search";
          if (event.key === "Backspace" && !typing && browser && !interactionsLocked) {
            event.preventDefault();
            goUp();
            return;
          }
          if (event.key !== "Tab") return;
          const dialog = dialogRef.current;
          if (!dialog) return;
          const focusable = Array.from(
            dialog.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((element) => element.getClientRects().length > 0);
          if (focusable.length === 0) {
            event.preventDefault();
            dialog.focus();
            return;
          }
          const first = focusable[0];
          const last = focusable.at(-1);
          if (
            (event.shiftKey &&
              (document.activeElement === first || document.activeElement === dialog)) ||
            (!event.shiftKey && document.activeElement === last)
          ) {
            event.preventDefault();
            (event.shiftKey ? last : first)?.focus();
          }
        }}
      >
        <header className="pb-header">
          <div>
            <h1 id="project-browser-title">Open a project</h1>
            <p>Lightcode works only inside the folder you open.</p>
          </div>
          {dismissible ? (
            <button
              className="icon-button"
              type="button"
              onClick={onClose}
              disabled={nativePickerPending}
              aria-label="Close project browser"
            >
              <Icon name="x" />
            </button>
          ) : null}
        </header>

        <div className="pb-toolbar">
          <button
            className="icon-button compact"
            type="button"
            onClick={goUp}
            disabled={interactionsLocked || !browser}
            aria-label={browser?.segments.length ? "Go to parent folder" : "Back to places"}
            title="Up (Backspace)"
          >
            <Icon name="back" size={16} />
          </button>
          <nav className="pb-address" aria-label="Current folder">
            <button
              type="button"
              className="pb-crumb home"
              onClick={goHome}
              disabled={interactionsLocked}
              aria-label="Places"
            >
              <Icon name="home" size={14} />
            </button>
            {browser ? (
              <>
                <Icon name="chevron-right" size={13} />
                <button
                  type="button"
                  className="pb-crumb"
                  onClick={() => goToSegment(0)}
                  disabled={interactionsLocked}
                >
                  {workspaceLocationName(browser.location)}
                </button>
                {browser.segments.map((segment, index) => (
                  <span className="pb-crumb-group" key={`${segment}-${index}`}>
                    <Icon name="chevron-right" size={13} />
                    <button
                      type="button"
                      className="pb-crumb"
                      onClick={() => goToSegment(index + 1)}
                      disabled={interactionsLocked}
                      aria-current={index === browser.segments.length - 1 ? "location" : undefined}
                    >
                      {segment}
                    </button>
                  </span>
                ))}
              </>
            ) : (
              <span className="pb-crumb-label">Places</span>
            )}
          </nav>
          {browser ? (
            <label className="pb-filter">
              <Icon name="search" size={14} />
              <input
                type="search"
                value={filter}
                placeholder="Filter folders"
                aria-label="Filter folders"
                onChange={(event) => setFilter(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    listRef.current?.querySelector<HTMLButtonElement>(".pb-row-main:not(:disabled)")?.focus();
                  } else if (event.key === "Enter" && directoryEntries.length === 1) {
                    event.preventDefault();
                    const only = directoryEntries[0];
                    if (only) enterDirectory(only);
                  }
                }}
              />
            </label>
          ) : null}
        </div>

        <div className="pb-main">
          <aside className="pb-sidebar" aria-label="Places">
            <button
              className={browser || openingLocationId ? "pb-side-item" : "pb-side-item active"}
              type="button"
              onClick={goHome}
              disabled={interactionsLocked}
            >
              <Icon name="home" size={16} />
              <span>Home</span>
            </button>
            {sidebarRecents.length > 0 ? (
              <>
                <h2>Recent</h2>
                {sidebarRecents.map((project) => (
                  <button
                    key={project.key}
                    className="pb-side-item"
                    type="button"
                    title={project.pathLabel}
                    disabled={interactionsLocked}
                    onClick={() => onOpenRecent(project)}
                  >
                    <Icon name="history" size={16} />
                    <span>{project.name}</span>
                  </button>
                ))}
              </>
            ) : null}
            {places.length > 0 ? (
              <>
                <h2>Places</h2>
                {places.map(placeButton)}
              </>
            ) : null}
            {drives ? (
              <>
                <h2>Devices</h2>
                {placeButton(drives)}
              </>
            ) : null}
          </aside>

          <div
            className="pb-content"
            aria-live="polite"
            aria-busy={isLoading || nativePickerPending}
          >
            {notice ? (
              <div
                className={`picker-fallback-notice ${notice.tone}`}
                role={notice.tone === "error" ? "alert" : "status"}
              >
                <Icon name={notice.tone === "error" ? "warning" : "folder-open"} size={18} />
                <span>
                  <strong>{notice.title}</strong>
                  <small>{notice.detail}</small>
                </span>
                <div className="picker-fallback-actions">
                  {notice.action ? (
                    <button
                      className="primary-button"
                      type="button"
                      onClick={notice.action.onSelect}
                      disabled={interactionsLocked}
                    >
                      {notice.action.label}
                    </button>
                  ) : null}
                  {notice.retryable && systemPickerLabel ? (
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={onUseSystemPicker}
                      disabled={nativePickerPending}
                    >
                      Try again
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {isLoading ? (
              <div className="folder-loading-status" role="status">
                <span className="inline-spinner" aria-hidden="true" />
                {loadingLabel}
              </div>
            ) : null}
            {isLoading && !browser ? <FolderSkeleton /> : null}
            {error ? (
              <div className="browser-state error-state" role="alert" aria-atomic="true">
                <Icon name={errorKind === "auth" ? "shield" : "warning"} size={24} />
                <h2>{errorHeading}</h2>
                <p>
                  {errorKind === "os-permission"
                    ? `${error} Allow your terminal or Lightcode to access ${failedLocationName}, then retry.`
                    : errorKind === "auth"
                      ? `${error} Run lightcode web again and use the new tab.`
                      : error}
                </p>
                {errorKind !== "auth" && retry ? (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={retryBrowserOperation}
                    disabled={interactionsLocked}
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            ) : null}

            {!error && browser ? (
              <div ref={listRef} className={isLoading ? "pb-list loading" : "pb-list"}>
                {directoryEntries.map((entry) => {
                  const childSegments = [...browser.segments, entry.name];
                  const canOpenChild =
                    entry.selectable && isSelectableBrowserPath(browser.location, childSegments);
                  return (
                    <div className="pb-row" key={entry.name}>
                      <button
                        className="pb-row-main"
                        type="button"
                        onClick={() => enterDirectory(entry)}
                        onKeyDown={(event) => {
                          const step =
                            event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
                          if (!step) return;
                          event.preventDefault();
                          const rows = Array.from(
                            listRef.current?.querySelectorAll<HTMLButtonElement>(
                              ".pb-row-main:not(:disabled)",
                            ) ?? [],
                          );
                          rows[rows.indexOf(event.currentTarget) + step]?.focus();
                        }}
                        disabled={interactionsLocked || !entry.selectable}
                        title={entry.name}
                      >
                        <Icon
                          name={isDrivesLocation(browser.location) && browser.segments.length === 0 ? "drive" : "folder"}
                          size={18}
                        />
                        <span className="pb-row-name">{entry.name}</span>
                        {entry.note ? <span className="entry-note">{entry.note}</span> : null}
                      </button>
                      {canOpenChild ? (
                        <button
                          className="pb-row-open"
                          type="button"
                          onClick={() => void chooseFolder(childSegments)}
                          disabled={interactionsLocked}
                          aria-label={`Open ${entry.name} as the project`}
                        >
                          Open
                        </button>
                      ) : (
                        <Icon name="chevron-right" size={15} />
                      )}
                    </div>
                  );
                })}
                {fileEntries.map((entry) => (
                  <div className="pb-row file" key={entry.name} aria-disabled="true">
                    <span className="pb-row-main">
                      <Icon name="document" size={18} />
                      <span className="pb-row-name">{entry.name}</span>
                      <span className="entry-note">{entry.note ?? entry.kind}</span>
                    </span>
                  </div>
                ))}
                {browser.entries.length > 0 && visibleEntries.length === 0 ? (
                  <div className="browser-state empty-state">
                    <Icon name="search" size={22} />
                    <h2>No folders match “{filter.trim()}”</h2>
                    <p>Clear the filter to see everything in this folder.</p>
                  </div>
                ) : null}
                {browser.entries.length === 0 ? (
                  <div className="browser-state empty-state">
                    <Icon name="folder-open" size={24} />
                    <h2>
                      {showFiles || !canSelectCurrent
                        ? "This folder is empty"
                        : "No folders here"}
                    </h2>
                    <p>
                      {!canSelectCurrent
                        ? "Open a folder inside a drive to use it as a project."
                        : showFiles
                          ? "You can still open it as a Lightcode project."
                          : "Turn on Show files to see what it contains. You can still open it as a Lightcode project."}
                    </p>
                  </div>
                ) : null}
                {browser.nextCursor ? (
                  <button
                    className="load-more-button"
                    type="button"
                    disabled={interactionsLocked}
                    onClick={() =>
                      void loadDirectory({
                        browserId: browser.browserId,
                        location: browser.location,
                        segments: browser.segments,
                        append: true,
                        cursor: browser.nextCursor ?? undefined,
                        loadingMessage: "Loading more folders",
                      })
                    }
                  >
                    Load more folders
                  </button>
                ) : null}
              </div>
            ) : null}

            {!error && !browser && !isLoading ? (
              <div className="pb-home">
                {recentProjects.length > 0 ? (
                  <section aria-label="Recent projects">
                    <h2>Recent projects</h2>
                    <div className="pb-cards">
                      {recentProjects.map((project) => (
                        <button
                          key={project.key}
                          className="pb-card"
                          type="button"
                          title={project.pathLabel}
                          disabled={interactionsLocked || !project.available}
                          onClick={() => onOpenRecent(project)}
                        >
                          <Icon name="folder-open" size={20} />
                          <span>
                            <strong>{project.name}</strong>
                            <small>{project.available ? project.pathLabel : "Unavailable"}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                ) : null}
                {locations.length > 0 ? (
                  <section aria-label="Places">
                    <h2>Browse</h2>
                    <div className="pb-tiles">
                      {locations.map((location) => {
                        const missing = missingLocations.get(location.id);
                        const name = workspaceLocationName(location);
                        const detail = missing
                          ? "Not found"
                          : isDrivesLocation(location)
                            ? "Drives"
                            : location.pathLabel && location.pathLabel !== name
                              ? location.pathLabel
                              : null;
                        return (
                          <button
                            key={location.id}
                            className={missing ? "pb-tile missing" : "pb-tile"}
                            type="button"
                            title={missing ?? location.pathLabel}
                            disabled={interactionsLocked}
                            onClick={() => void openLocation(location)}
                          >
                            <Icon name={locationIcon(location)} size={22} />
                            <strong>{name}</strong>
                            {detail ? <small>{detail}</small> : null}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <footer className={confirmBroadRoot ? "pb-footer has-root-confirmation" : "pb-footer"}>
          {confirmBroadRoot ? (
            <div className="broad-root-warning" role="alert">
              <Icon name="warning" size={17} />
              <span>{browser ? broadWorkspaceRootWarning(browser.location) : "Choose a project folder for narrower access."}</span>
              <button
                type="button"
                onClick={() => setConfirmBroadRoot(false)}
                disabled={interactionsLocked}
              >
                Keep browsing
              </button>
            </div>
          ) : (
            <div className="pb-footer-info">
              <span className="selected-path" title={browser?.pathLabel}>
                {browser?.pathLabel ?? "Pick a place, then open a folder"}
              </span>
              {browser ? (
                <span className="pb-view-options">
                  <label className="checkbox-control">
                    <input
                      type="checkbox"
                      checked={includeHidden}
                      disabled={interactionsLocked}
                      onChange={(event) => setHiddenFolders(event.currentTarget.checked)}
                    />
                    Hidden items
                  </label>
                  <label className="checkbox-control">
                    <input
                      type="checkbox"
                      checked={showFiles}
                      disabled={interactionsLocked}
                      onChange={(event) => setFileVisibility(event.currentTarget.checked)}
                    />
                    Files
                  </label>
                </span>
              ) : null}
            </div>
          )}
          <div className="project-browser-actions">
            {systemPickerLabel ? (
              nativePickerPending ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={onCancelSystemPicker}
                  aria-busy="true"
                >
                  <span className="inline-spinner" aria-hidden="true" />
                  Cancel dialog
                </button>
              ) : (
                <button
                  className="secondary-button pb-system-picker"
                  type="button"
                  onClick={onUseSystemPicker}
                  disabled={isLoading || isSelecting}
                >
                  {systemPickerLabel}
                </button>
              )
            ) : null}
            {dismissible ? (
              <button
                className="secondary-button"
                type="button"
                onClick={onClose}
                disabled={nativePickerPending}
              >
                Cancel
              </button>
            ) : null}
            <button
              className="primary-button"
              type="button"
              onClick={() => browser && void chooseFolder(browser.segments)}
              disabled={!browser || !canSelectCurrent || interactionsLocked || Boolean(error)}
              title={
                browser && !canSelectCurrent
                  ? "Open a folder inside a drive to use it as a project."
                  : undefined
              }
            >
              {isSelecting
                ? "Opening project"
                : confirmBroadRoot
                  ? `Confirm ${currentLocationName} access`
                  : "Open project"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function FolderSkeleton() {
  return (
    <div className="folder-skeleton" role="status" aria-label="Loading folders">
      {Array.from({ length: 7 }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  );
}
