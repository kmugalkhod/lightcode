import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BrowserEntry,
  LightcodeApi,
  Workspace,
  WorkspaceLocation,
} from "../lib/api";
import { LightcodeApiError, requiresBroadWorkspaceConfirmation } from "../lib/api";
import {
  broadWorkspaceRootWarning,
  workspaceLocationName,
  workspaceLocationPath,
} from "../lib/workspace-location";
import {
  createExclusiveRequestGate,
  type ExclusiveRequestGate,
} from "../lib/exclusive-request-gate";
import { Icon } from "./icons";

interface ProjectBrowserProps {
  api: LightcodeApi;
  dismissible: boolean;
  onClose: () => void;
  onSelect: (workspace: Workspace) => void;
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
  | { kind: "select" };

function classifyBrowserError(cause: unknown): BrowserErrorKind {
  if (!(cause instanceof LightcodeApiError)) return "other";
  const code =
    cause.payload && typeof cause.payload === "object"
      ? Reflect.get(cause.payload, "code")
      : null;
  if (code === "os_permission_denied") return "os-permission";
  if (cause.status === 401 || (typeof code === "string" && code.startsWith("web_auth_"))) {
    return "auth";
  }
  return "other";
}

export function ProjectBrowser({
  api,
  dismissible,
  onClose,
  onSelect,
}: ProjectBrowserProps) {
  const [locations, setLocations] = useState<WorkspaceLocation[]>([]);
  const [browser, setBrowser] = useState<BrowserState | null>(null);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSelecting, setIsSelecting] = useState(false);
  const [confirmBroadRoot, setConfirmBroadRoot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<BrowserErrorKind>("other");
  const [retry, setRetry] = useState<BrowserRetry | null>(null);
  const [openingLocationId, setOpeningLocationId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
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
      requestId,
    }: {
      browserId: string;
      location: WorkspaceLocation;
      segments: string[];
      append?: boolean;
      cursor?: string;
      includeHiddenValue?: boolean;
      requestId?: number;
    }) => {
      const ownsRequest = requestId === undefined;
      const activeRequestId = requestId ?? requestGate.tryStart();
      if (activeRequestId === null || !requestGate.isCurrent(activeRequestId)) return;

      setConfirmBroadRoot(false);
      setIsLoading(true);
      setError(null);
      setRetry(null);
      try {
        const page = await api.listEntries({
          browserId,
          segments,
          cursor,
          includeHidden: includeHiddenValue ?? includeHidden,
        });
        if (!requestGate.isCurrent(activeRequestId)) return;
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
    [api, includeHidden, requestGate],
  );

  const openLocation = useCallback(
    async (location: WorkspaceLocation) => {
      const requestId = requestGate.tryStart();
      if (requestId === null) return;

      setConfirmBroadRoot(false);
      setIsLoading(true);
      setError(null);
      setRetry(null);
      setOpeningLocationId(location.id);
      try {
        const opened = await api.openLocation(location.id);
        if (!requestGate.isCurrent(requestId)) return;
        await loadDirectory({
          browserId: opened.browserId,
          location: opened.location ?? location,
          segments: [],
          requestId,
        });
      } catch (cause) {
        if (!requestGate.isCurrent(requestId)) return;
        setErrorKind(classifyBrowserError(cause));
        setError(cause instanceof Error ? cause.message : "Unable to open this location.");
        setRetry({ kind: "open", location });
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
    // browser capability must remain behind the explicit button below.
  }, [loadLocations, requestGate]);

  const directoryEntries = useMemo(
    () => browser?.entries.filter((entry) => entry.kind === "directory") ?? [],
    [browser?.entries],
  );
  const fileEntries = useMemo(
    () => browser?.entries.filter((entry) => entry.kind !== "directory") ?? [],
    [browser?.entries],
  );

  async function chooseCurrentFolder() {
    if (!browser || requestGate.isBusy()) return;
    if (requiresBroadWorkspaceConfirmation(browser.segments) && !confirmBroadRoot) {
      setConfirmBroadRoot(true);
      return;
    }

    const requestId = requestGate.tryStart();
    if (requestId === null) return;
    setIsSelecting(true);
    setError(null);
    setRetry(null);
    try {
      const workspace = await api.selectWorkspace(browser.browserId, browser.segments);
      if (requestGate.isCurrent(requestId) && mountedRef.current) {
        onSelect(workspace);
      }
    } catch (cause) {
      if (!requestGate.isCurrent(requestId)) return;
      setErrorKind(classifyBrowserError(cause));
      setError(cause instanceof Error ? cause.message : "Unable to select this project.");
      setRetry({ kind: "select" });
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
    });
  }

  function goToSegment(index: number) {
    if (!browser || requestGate.isBusy()) return;
    void loadDirectory({
      browserId: browser.browserId,
      location: browser.location,
      segments: browser.segments.slice(0, index),
    });
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
      void chooseCurrentFolder();
    }
  }

  const defaultLocation = locations[0] ?? null;
  const interactionsLocked = isLoading || isSelecting;
  const activeLocationId = openingLocationId ?? browser?.location.id ?? null;
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

  return (
    <div className="project-browser-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="project-browser"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-browser-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape" && dismissible) onClose();
        }}
      >
        <header className="project-browser-header">
          <div>
            <h1 id="project-browser-title">Choose a project</h1>
            <p>Browse local folders. The agent works only inside the folder you select.</p>
          </div>
          {dismissible ? (
            <button className="icon-button" type="button" onClick={onClose} aria-label="Close project browser">
              <Icon name="x" />
            </button>
          ) : null}
        </header>

        <nav className="location-strip" aria-label="Local folder locations">
          {locations.map((location) => (
            <button
              key={location.id}
              className={activeLocationId === location.id ? "location-button active" : "location-button"}
              type="button"
              aria-current={activeLocationId === location.id ? "location" : undefined}
              aria-label={`Open ${workspaceLocationName(location)}`}
              title={location.pathLabel}
              disabled={interactionsLocked}
              onClick={() => void openLocation(location)}
            >
              <Icon name="folder" size={16} />
              <span>{workspaceLocationName(location)}</span>
            </button>
          ))}
        </nav>

        <nav className="folder-breadcrumbs" aria-label="Current folder">
          {browser ? (
            <>
              <button
                className="icon-button compact"
                type="button"
                onClick={() => goToSegment(Math.max(0, browser.segments.length - 1))}
                disabled={interactionsLocked || browser.segments.length === 0}
                aria-label="Go to parent folder"
              >
                <Icon name="back" size={16} />
              </button>
              <button type="button" onClick={() => goToSegment(0)} disabled={interactionsLocked}>
                {workspaceLocationName(browser.location)}
              </button>
              {browser.segments.map((segment, index) => (
                <span key={`${segment}-${index}`}>
                  <Icon name="chevron-right" size={14} />
                  <button
                    type="button"
                    onClick={() => goToSegment(index + 1)}
                    disabled={interactionsLocked}
                  >
                    {segment}
                  </button>
                </span>
              ))}
            </>
          ) : (
            <span>Choose a location above to browse</span>
          )}
        </nav>

        <div className="project-browser-body" aria-live="polite" aria-busy={isLoading}>
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
              {errorKind !== "auth" ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={retryBrowserOperation}
                  disabled={interactionsLocked || !retry}
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
          {!error && browser ? (
            <div className={isLoading ? "folder-list loading" : "folder-list"}>
              {directoryEntries.map((entry) => (
                <button
                  className="folder-row"
                  key={entry.name}
                  type="button"
                  onClick={() => enterDirectory(entry)}
                  disabled={interactionsLocked || !entry.selectable}
                >
                  <Icon name="folder" size={18} />
                  <span>{entry.name}</span>
                  {entry.note ? <span className="entry-note">{entry.note}</span> : null}
                  <Icon name="chevron-right" size={15} />
                </button>
              ))}
              {fileEntries.map((entry) => (
                <div className="folder-row file-row" key={entry.name} aria-disabled="true">
                  <Icon name="code" size={18} />
                  <span>{entry.name}</span>
                  <span className="entry-note">{entry.note ?? entry.kind}</span>
                </div>
              ))}
              {browser.entries.length === 0 ? (
                <div className="browser-state empty-state">
                  <Icon name="folder-open" size={24} />
                  <h2>This folder is empty</h2>
                  <p>You can still use it as a Lightcode project.</p>
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
                    })
                  }
                >
                  Load more folders
                </button>
              ) : null}
            </div>
          ) : null}
          {!isLoading && !error && !browser && defaultLocation ? (
            <div className="browser-state browser-consent-state">
              <Icon name="folder-open" size={26} />
              <h2>Browse local folders</h2>
              <p>Choose a location above, then select the project the agent may work inside.</p>
              <button
                className="primary-button"
                type="button"
                onClick={() => void openLocation(defaultLocation)}
                disabled={interactionsLocked}
              >
                Open {workspaceLocationName(defaultLocation)}
                <Icon name="chevron-right" size={16} />
              </button>
            </div>
          ) : null}
        </div>

        <footer className={confirmBroadRoot ? "project-browser-footer has-root-confirmation" : "project-browser-footer"}>
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
            <label className="checkbox-control">
              <input
                type="checkbox"
                checked={includeHidden}
                disabled={interactionsLocked}
                onChange={(event) => setHiddenFolders(event.currentTarget.checked)}
              />
              Show hidden folders
            </label>
          )}
          <div className="project-browser-actions">
            <span className="selected-path" title={browser?.pathLabel}>
              {browser?.pathLabel ?? "Choose a local folder"}
            </span>
            <button
              className="primary-button"
              type="button"
              onClick={() => void chooseCurrentFolder()}
              disabled={!browser || interactionsLocked || Boolean(error)}
            >
              {isSelecting
                ? "Opening project"
                : confirmBroadRoot
                  ? `Confirm ${currentLocationName} access`
                  : "Use this folder"}
              <Icon name="chevron-right" size={16} />
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
