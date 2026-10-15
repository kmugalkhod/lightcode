import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeDiff, ChangedFile, LightcodeApi, SessionChanges } from "../lib/api";
import { Icon } from "./icons";
import { DiffView } from "./tool-parts/tool-view-body";

const kindMarks: Record<ChangedFile["changeKind"], { letter: string; label: string }> = {
  created: { letter: "A", label: "added" },
  modified: { letter: "M", label: "modified" },
  deleted: { letter: "D", label: "deleted" },
  renamed: { letter: "R", label: "renamed" },
  untracked: { letter: "U", label: "untracked" },
};

function splitPath(filePath: string): { directory: string; name: string } {
  const index = filePath.lastIndexOf("/");
  return index === -1
    ? { directory: "", name: filePath }
    : { directory: filePath.slice(0, index + 1), name: filePath.slice(index + 1) };
}

/**
 * Git changes in the session's project: changed files with +/- counts, and
 * the selected file's diff. Refreshes whenever `refreshKey` changes (after
 * each tool result and run).
 */
export function ChangesPanel({
  api,
  sessionId,
  refreshKey,
  onClose,
  onCountChange,
}: {
  api: LightcodeApi;
  sessionId: string;
  refreshKey: number;
  onClose: () => void;
  onCountChange: (count: number) => void;
}) {
  const [changes, setChanges] = useState<SessionChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<ChangeDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.listChanges(sessionId);
      setChanges(next);
      onCountChange(next.files.length);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to read changes.");
    } finally {
      setLoading(false);
    }
  }, [api, onCountChange, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  // Selection is by path so it survives refreshes (ids are per-list).
  const selected = changes?.files.find((file) => file.path === selectedPath) ?? null;
  useEffect(() => {
    if (!selected) {
      setDiff(null);
      setDiffError(null);
      return;
    }
    let cancelled = false;
    setDiffError(null);
    void api
      .getChangeDiff(sessionId, selected.fileId)
      .then((next) => {
        if (!cancelled) setDiff(next);
      })
      .catch((cause) => {
        if (!cancelled) {
          setDiff(null);
          setDiffError(cause instanceof Error ? cause.message : "Unable to load the diff.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, selected?.fileId, sessionId]);

  function moveSelection(delta: number) {
    const files = changes?.files ?? [];
    if (files.length === 0) return;
    const index = files.findIndex((file) => file.path === selectedPath);
    const next = files[Math.min(files.length - 1, Math.max(0, index + delta))];
    if (next) {
      setSelectedPath(next.path);
      listRef.current
        ?.querySelector<HTMLButtonElement>(`[data-path="${CSS.escape(next.path)}"]`)
        ?.focus();
    }
  }

  const files = changes?.files ?? [];
  return (
    <aside
      className="changes-panel"
      aria-label="Changes"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="changes-panel-header">
        <h2>
          Changes
          {changes?.isRepo ? <span className="changes-count">{files.length}</span> : null}
        </h2>
        {changes?.branch ? <span className="changes-branch">{changes.branch}</span> : null}
        <button
          className="icon-button compact"
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label="Refresh changes"
          title="Refresh"
        >
          {loading ? <span className="inline-spinner" aria-hidden="true" /> : <Icon name="history" size={15} />}
        </button>
        <button className="icon-button compact" type="button" onClick={onClose} aria-label="Close changes">
          <Icon name="x" size={15} />
        </button>
      </header>

      {error ? (
        <div className="changes-state" role="alert">
          <Icon name="warning" size={18} />
          <p>{error}</p>
        </div>
      ) : changes && !changes.isRepo ? (
        <div className="changes-state">
          <Icon name="folder-open" size={18} />
          <p>This project is not a git repository, so there are no changes to show.</p>
        </div>
      ) : changes && files.length === 0 ? (
        <div className="changes-state">
          <Icon name="check" size={18} />
          <p>No uncommitted changes.</p>
        </div>
      ) : (
        <ul
          className="changes-list"
          ref={listRef}
          aria-label="Changed files"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              moveSelection(event.key === "ArrowDown" ? 1 : -1);
            }
          }}
        >
          {files.map((file) => {
            const { directory, name } = splitPath(file.path);
            const mark = kindMarks[file.changeKind];
            return (
              <li key={file.fileId}>
                <button
                  type="button"
                  data-path={file.path}
                  className={file.path === selectedPath ? "changes-row selected" : "changes-row"}
                  aria-current={file.path === selectedPath ? "true" : undefined}
                  onClick={() => setSelectedPath(file.path === selectedPath ? null : file.path)}
                  title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
                >
                  <span className={`change-kind ${file.changeKind}`} aria-label={mark.label}>
                    {mark.letter}
                  </span>
                  <span className="changes-path">
                    <strong>{name}</strong>
                    {directory ? <small>{directory}</small> : null}
                  </span>
                  {file.added !== null && file.removed !== null ? (
                    <span className="changes-stats">
                      <span className="added">+{file.added}</span>
                      <span className="removed">−{file.removed}</span>
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selected ? (
        <section className="changes-diff" aria-label={`Diff of ${selected.path}`}>
          {diffError ? (
            <p className="changes-state" role="alert">{diffError}</p>
          ) : !diff ? (
            <p className="changes-state">Loading diff…</p>
          ) : diff.binary ? (
            <p className="changes-state">Binary file; no text diff.</p>
          ) : diff.diff.trim() ? (
            <>
              <DiffView diff={diff.diff} />
              {diff.truncated ? <p className="changes-state">Diff truncated.</p> : null}
            </>
          ) : (
            <p className="changes-state">No textual changes.</p>
          )}
        </section>
      ) : files.length > 0 ? (
        <p className="changes-hint">Select a file to see its diff. ↑/↓ moves between files.</p>
      ) : null}
    </aside>
  );
}
