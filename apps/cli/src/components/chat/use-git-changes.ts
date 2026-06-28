import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { countDiffStats } from "./chat-message-tool-invocation-part";
import type { ChangedFile, ChangedFileChangeKind } from "./use-changed-files";

/** Lazily load the (heavy) AI runtime once and reuse the module. */
let runtimePromise: Promise<typeof import("@lightcode/ai/runtime")> | null = null;
function loadRuntime() {
  runtimePromise ??= import("@lightcode/ai/runtime");
  return runtimePromise;
}

const REFRESH_DEBOUNCE_MS = 750;

interface GitStatusEntry {
  path: string;
  indexStatus: string;
  workingTreeStatus: string;
  originalPath: string | null;
}

export interface GitChangesApi {
  files: ChangedFile[];
  branch: string | null;
  ahead: number;
  behind: number;
  loading: boolean;
  /** Error message, or null. Set to a friendly note for non-git directories. */
  error: string | null;
  isRepo: boolean;
  refresh: () => void;
  /** Ensure the unified diff for a path is loaded (lazy, cached). */
  requestDiff: (path: string) => void;
}

const EMPTY: GitChangesApi = {
  files: [],
  branch: null,
  ahead: 0,
  behind: 0,
  loading: false,
  error: null,
  isRepo: true,
  refresh: () => {},
  requestDiff: () => {},
};

/** Map a porcelain XY status pair to our change-kind vocabulary. */
export function kindFromStatus(indexStatus: string, workingTreeStatus: string): ChangedFileChangeKind {
  if (indexStatus === "?" || workingTreeStatus === "?") {
    return "untracked";
  }
  const code = (workingTreeStatus.trim() || indexStatus.trim()).toUpperCase();
  switch (code) {
    case "A":
      return "created";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return "modified";
  }
}

/**
 * Real git working-tree changes (Source Control style), reusing the runtime's
 * git_status / git_diff tools. Diffs load lazily per requested path. Hidden when
 * `enabled` is false so git is only run once the Changes view is shown.
 */
export function useGitChanges({
  cwd,
  enabled,
}: {
  cwd: string;
  enabled: boolean;
}): GitChangesApi {
  const [entries, setEntries] = useState<GitStatusEntry[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [ahead, setAhead] = useState(0);
  const [behind, setBehind] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRepo, setIsRepo] = useState(true);
  const [diffByPath, setDiffByPath] = useState<Map<string, string>>(() => new Map());

  const aliveRef = useRef(true);
  const lastRefreshAtRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const diffInFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    if (refreshInFlightRef.current) {
      return;
    }
    refreshInFlightRef.current = true;
    setLoading(true);
    void (async () => {
      try {
        const runtime = await loadRuntime();
        const context = runtime.createWorkspaceContext(cwd);
        const status = await runtime.executeGitStatus({}, context);
        if (!aliveRef.current) {
          return;
        }
        if (!status.ok) {
          setIsRepo(false);
          setError(status.error?.message ?? "Not a git repository.");
          setEntries([]);
          return;
        }
        setIsRepo(true);
        setError(null);
        setBranch(status.branch ?? null);
        setAhead(status.ahead ?? 0);
        setBehind(status.behind ?? 0);
        setEntries(status.entries as GitStatusEntry[]);
        // Drop cached diffs for paths that are no longer changed.
        setDiffByPath((current) => {
          const live = new Set(status.entries.map((entry) => entry.path));
          const next = new Map<string, string>();
          for (const [path, diff] of current) {
            if (live.has(path)) {
              next.set(path, diff);
            }
          }
          return next;
        });
      } catch (caught) {
        if (aliveRef.current) {
          setError(caught instanceof Error ? caught.message : "Failed to read git status.");
        }
      } finally {
        lastRefreshAtRef.current = Date.now();
        refreshInFlightRef.current = false;
        if (aliveRef.current) {
          setLoading(false);
        }
      }
    })();
  }, [cwd]);

  // Initial load when the view becomes enabled.
  const wasEnabledRef = useRef(false);
  useEffect(() => {
    if (enabled && !wasEnabledRef.current) {
      wasEnabledRef.current = true;
      refresh();
    } else if (!enabled) {
      wasEnabledRef.current = false;
    }
  }, [enabled, refresh]);

  const requestDiff = useCallback(
    (path: string) => {
      if (!path || diffByPath.has(path) || diffInFlightRef.current.has(path)) {
        return;
      }
      diffInFlightRef.current.add(path);
      void (async () => {
        try {
          const runtime = await loadRuntime();
          const context = runtime.createWorkspaceContext(cwd);
          let result = await runtime.executeGitDiff({ path }, context);
          // Fall back to the staged diff when there's no unstaged change.
          if (result.ok && !result.diff.trim()) {
            const staged = await runtime.executeGitDiff({ path, staged: true }, context);
            if (staged.ok && staged.diff.trim()) {
              result = staged;
            }
          }
          if (!aliveRef.current) {
            return;
          }
          setDiffByPath((current) => {
            const next = new Map(current);
            next.set(path, result.ok ? result.diff : "");
            return next;
          });
        } catch {
          if (aliveRef.current) {
            setDiffByPath((current) => new Map(current).set(path, ""));
          }
        } finally {
          diffInFlightRef.current.delete(path);
        }
      })();
    },
    [cwd, diffByPath],
  );

  const files = useMemo<ChangedFile[]>(() => {
    return entries.map((entry, index) => {
      const diff = diffByPath.get(entry.path) ?? "";
      const { added, removed } = diff ? countDiffStats(diff) : { added: 0, removed: 0 };
      return {
        path: entry.path,
        diff,
        addedLines: added,
        removedLines: removed,
        lastToolPartId: entry.path,
        status: "done",
        changeKind: kindFromStatus(entry.indexStatus, entry.workingTreeStatus),
        lastTouchedSeq: index,
      } satisfies ChangedFile;
    });
  }, [entries, diffByPath]);

  if (!enabled) {
    return EMPTY;
  }

  return { files, branch, ahead, behind, loading, error, isRepo, refresh, requestDiff };
}
