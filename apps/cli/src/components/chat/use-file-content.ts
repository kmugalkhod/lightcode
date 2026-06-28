import { promises as fs } from "node:fs";
import { useEffect, useState } from "react";

/** Lazily load the (heavy) AI runtime once and reuse the module. */
let runtimePromise: Promise<typeof import("@lightcode/ai/runtime")> | null = null;
function loadRuntime() {
  runtimePromise ??= import("@lightcode/ai/runtime");
  return runtimePromise;
}

/**
 * Upper bound on what the editor view will render. The agent's read_file tool
 * caps at ~12k chars; the panel is a viewer, not a token budget, so we read the
 * file directly (resolved safely within the workspace) up to this size and mark
 * anything larger as truncated.
 */
const MAX_VIEW_CHARS = 400_000;

export interface FileContentState {
  path: string | null;
  content: string;
  totalLines: number;
  truncated: boolean;
  loading: boolean;
  error: string | null;
}

const EMPTY: FileContentState = {
  path: null,
  content: "",
  totalLines: 0,
  truncated: false,
  loading: false,
  error: null,
};

function looksBinary(sample: string): boolean {
  // A NUL byte in the first chunk is a reliable "this isn't text" signal.
  return sample.includes("\u0000");
}

/**
 * Reads the whole content of `path` (workspace-relative) for the editor view.
 * Re-reads whenever the path changes (or `reloadToken` is bumped, e.g. after a
 * save); returns an idle state when path is null.
 */
export function useFileContent(
  path: string | null,
  cwd: string,
  reloadToken = 0,
): FileContentState {
  const [state, setState] = useState<FileContentState>(EMPTY);

  useEffect(() => {
    if (!path) {
      setState(EMPTY);
      return;
    }

    let cancelled = false;
    setState({ ...EMPTY, path, loading: true });

    void (async () => {
      try {
        const runtime = await loadRuntime();
        const context = runtime.createWorkspaceContext(cwd);
        // Resolve through the workspace guard so the viewer can never escape the
        // project root, then read the file straight from disk.
        const resolved = runtime.resolveWithinWorkspace(path, { context });
        const raw = await fs.readFile(resolved, "utf8");
        if (cancelled) {
          return;
        }

        if (looksBinary(raw.slice(0, 4096))) {
          setState({
            ...EMPTY,
            path,
            error: "Binary file — not shown.",
          });
          return;
        }

        const truncated = raw.length > MAX_VIEW_CHARS;
        const content = truncated ? raw.slice(0, MAX_VIEW_CHARS) : raw;
        setState({
          path,
          content,
          totalLines: raw.split(/\r?\n/).length,
          truncated,
          loading: false,
          error: null,
        });
      } catch (caught) {
        if (cancelled) {
          return;
        }
        setState({
          ...EMPTY,
          path,
          error: caught instanceof Error ? caught.message : "Failed to read file.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path, cwd, reloadToken]);

  return state;
}
