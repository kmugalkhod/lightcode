import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Lazily load the (heavy) AI runtime once and reuse the module. */
let runtimePromise: Promise<typeof import("@lightcode/ai/runtime")> | null = null;
function loadRuntime() {
  runtimePromise ??= import("@lightcode/ai/runtime");
  return runtimePromise;
}

type EntryType = "file" | "directory" | "symlink" | "other";

interface DirEntry {
  path: string;
  name: string;
  type: EntryType;
}

export interface FileTreeNode {
  /** Workspace-relative path, e.g. "apps/cli/src". */
  path: string;
  /** Basename. */
  name: string;
  type: EntryType;
  /** Indentation depth; 0 = top level. */
  depth: number;
  isDir: boolean;
  expanded: boolean;
  loading: boolean;
}

export interface FileTreeApi {
  nodes: FileTreeNode[];
  selectedPath: string | null;
  /** Currently selected path if it is a file (the one to open in the editor). */
  openFilePath: string | null;
  rootLoading: boolean;
  error: string | null;
  selectPath: (path: string) => void;
  toggleDir: (path: string) => void;
  moveSelection: (delta: number) => void;
  /** Enter: expand/collapse a directory (files are already opened on select). */
  activateSelected: () => void;
  /** Right arrow: expand a directory or step into its first child. */
  expandOrEnter: () => void;
  /** Left arrow: collapse a directory or jump to its parent. */
  collapseOrParent: () => void;
}

function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

function parentDir(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? null : normalized.slice(0, slash);
}

/** Directories first, then alphabetical — the conventional file-tree order. */
function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.type === "directory";
    const bDir = b.type === "directory";
    if (aDir !== bDir) {
      return aDir ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

/**
 * Lazy, editor-style project file tree. Lists one directory at a time via the
 * runtime's list_files tool, caching children and tracking expanded folders.
 * Hidden when `enabled` is false so the runtime is only touched once the user
 * opens the Files view.
 */
export function useFileTree({
  cwd,
  enabled,
}: {
  cwd: string;
  enabled: boolean;
}): FileTreeApi {
  const [rootEntries, setRootEntries] = useState<DirEntry[] | null>(null);
  const [childrenByDir, setChildrenByDir] = useState<Map<string, DirEntry[]>>(
    () => new Map(),
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [rootLoading, setRootLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guard against setting state after unmount / cwd change mid-flight.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Dedupe concurrent loads of the same directory (e.g. StrictMode double-fire).
  const inFlightRef = useRef<Set<string>>(new Set());

  const toEntries = useCallback(
    (raw: Array<{ path: string; type: EntryType }>): DirEntry[] =>
      raw.map((entry) => ({
        path: entry.path,
        name: basename(entry.path),
        type: entry.type,
      })),
    [],
  );

  const loadDir = useCallback(
    async (dirPath: string) => {
      if (inFlightRef.current.has(dirPath)) {
        return;
      }
      inFlightRef.current.add(dirPath);
      setLoadingDirs((current) => new Set(current).add(dirPath));
      try {
        const runtime = await loadRuntime();
        const context = runtime.createWorkspaceContext(cwd);
        const output = await runtime.executeListFiles(
          { path: dirPath, recursive: false, maxEntries: 200 },
          context,
        );
        if (!aliveRef.current) {
          return;
        }
        const entries = sortEntries(toEntries(output.entries));
        setChildrenByDir((current) => {
          const next = new Map(current);
          next.set(dirPath, entries);
          return next;
        });
      } catch (caught) {
        if (aliveRef.current) {
          setError(caught instanceof Error ? caught.message : "Failed to list files.");
        }
      } finally {
        inFlightRef.current.delete(dirPath);
        if (aliveRef.current) {
          setLoadingDirs((current) => {
            const next = new Set(current);
            next.delete(dirPath);
            return next;
          });
        }
      }
    },
    [cwd, toEntries],
  );

  // Load the project root the first time the tree is shown. Guarded by a ref
  // (not state) so that flipping rootLoading can't re-run the effect, cancel the
  // in-flight load, and leave the tree stuck on "Loading project…".
  const loadedRootForCwdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || loadedRootForCwdRef.current === cwd) {
      return;
    }
    loadedRootForCwdRef.current = cwd;
    setRootLoading(true);
    setError(null);
    void (async () => {
      try {
        const runtime = await loadRuntime();
        const context = runtime.createWorkspaceContext(cwd);
        const output = await runtime.executeListFiles(
          { path: ".", recursive: false, maxEntries: 200 },
          context,
        );
        if (!aliveRef.current) {
          return;
        }
        setRootEntries(sortEntries(toEntries(output.entries)));
      } catch (caught) {
        if (aliveRef.current) {
          // Allow a retry on the next open if the first attempt failed.
          loadedRootForCwdRef.current = null;
          setError(caught instanceof Error ? caught.message : "Failed to list files.");
        }
      } finally {
        if (aliveRef.current) {
          setRootLoading(false);
        }
      }
    })();
  }, [enabled, cwd, toEntries]);

  // Flatten the tree into the list of currently visible rows.
  const nodes = useMemo<FileTreeNode[]>(() => {
    if (!rootEntries) {
      return [];
    }
    const out: FileTreeNode[] = [];
    const walk = (entries: DirEntry[], depth: number) => {
      for (const entry of entries) {
        const isDir = entry.type === "directory";
        const isExpanded = isDir && expanded.has(entry.path);
        out.push({
          path: entry.path,
          name: entry.name,
          type: entry.type,
          depth,
          isDir,
          expanded: isExpanded,
          loading: loadingDirs.has(entry.path),
        });
        if (isExpanded) {
          const kids = childrenByDir.get(entry.path);
          if (kids) {
            walk(kids, depth + 1);
          }
        }
      }
    };
    walk(rootEntries, 0);
    return out;
  }, [rootEntries, expanded, childrenByDir, loadingDirs]);

  // Fetch a directory's children if we haven't already. Kept out of the
  // setExpanded updater on purpose: loadDir calls setState synchronously, and
  // OpenTUI's reconciler drops setState issued from inside another updater —
  // that previously left expanded folders stuck on the loading indicator.
  const ensureChildrenLoaded = useCallback(
    (dirPath: string) => {
      if (!childrenByDir.has(dirPath)) {
        void loadDir(dirPath);
      }
    },
    [childrenByDir, loadDir],
  );

  const toggleDir = useCallback(
    (dirPath: string) => {
      const isExpanded = expanded.has(dirPath);
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(dirPath)) {
          next.delete(dirPath);
        } else {
          next.add(dirPath);
        }
        return next;
      });
      if (!isExpanded) {
        ensureChildrenLoaded(dirPath);
      }
    },
    [expanded, ensureChildrenLoaded],
  );

  const expandDir = useCallback(
    (dirPath: string) => {
      if (expanded.has(dirPath)) {
        return;
      }
      setExpanded((current) => new Set(current).add(dirPath));
      ensureChildrenLoaded(dirPath);
    },
    [expanded, ensureChildrenLoaded],
  );

  const collapseDir = useCallback((dirPath: string) => {
    setExpanded((current) => {
      if (!current.has(dirPath)) {
        return current;
      }
      const next = new Set(current);
      next.delete(dirPath);
      return next;
    });
  }, []);

  const selectPath = useCallback((path: string) => {
    setSelectedPath(path);
  }, []);

  const moveSelection = useCallback(
    (delta: number) => {
      if (nodes.length === 0) {
        return;
      }
      const index = nodes.findIndex((node) => node.path === selectedPath);
      const base = index === -1 ? (delta > 0 ? -1 : 0) : index;
      const nextIndex = Math.min(nodes.length - 1, Math.max(0, base + delta));
      const next = nodes[nextIndex];
      if (next) {
        setSelectedPath(next.path);
      }
    },
    [nodes, selectedPath],
  );

  const selectedNode = useMemo(
    () => nodes.find((node) => node.path === selectedPath) ?? null,
    [nodes, selectedPath],
  );

  const activateSelected = useCallback(() => {
    if (selectedNode?.isDir) {
      toggleDir(selectedNode.path);
    }
  }, [selectedNode, toggleDir]);

  const expandOrEnter = useCallback(() => {
    if (!selectedNode) {
      return;
    }
    if (selectedNode.isDir) {
      if (!selectedNode.expanded) {
        expandDir(selectedNode.path);
      } else {
        moveSelection(1);
      }
    }
  }, [selectedNode, expandDir, moveSelection]);

  const collapseOrParent = useCallback(() => {
    if (!selectedNode) {
      return;
    }
    if (selectedNode.isDir && selectedNode.expanded) {
      collapseDir(selectedNode.path);
      return;
    }
    const parent = parentDir(selectedNode.path);
    if (parent) {
      setSelectedPath(parent);
    }
  }, [selectedNode, collapseDir]);

  const openFilePath =
    selectedNode && !selectedNode.isDir ? selectedNode.path : null;

  return {
    nodes,
    selectedPath,
    openFilePath,
    rootLoading,
    error,
    selectPath,
    toggleDir,
    moveSelection,
    activateSelected,
    expandOrEnter,
    collapseOrParent,
  };
}
