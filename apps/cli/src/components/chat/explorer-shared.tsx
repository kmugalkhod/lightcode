import { cliTheme, space, typeRole } from "../../ui/cli-theme";
import { activeGlyphs, terminalCapabilities } from "../../ui/cli-theme-capabilities";
import type { ChangedFileChangeKind } from "./use-changed-files";

/** Diffs under this many lines render in full in the panel's deep-look view. */
export const PANEL_DIFF_MAX_LINES = 400;

export const UNICODE = terminalCapabilities.unicode;

export const ELLIPSIS = UNICODE ? "…" : "...";

export const CLOSE_GLYPH = UNICODE ? "✕" : "x";

export const NO_CHANGE_GLYPH = UNICODE ? "—" : "-";

export const CARET_OPEN = UNICODE ? "▾" : "v";

export const CARET_CLOSED = UNICODE ? "▸" : ">";

// One faint vertical rule per depth level, like an editor's indent guides.
export const INDENT_GUIDE = UNICODE ? "│" : " ";

export const FILE_GLYPH = activeGlyphs.bullet;

export type PanelTab = "files" | "changes";

export type FileViewMode = "content" | "diff";

export function splitPath(path: string): { dir: string; base: string } {
  const normalized = path.replaceAll("\\", "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) {
    return { dir: "", base: normalized };
  }
  return {
    dir: normalized.slice(0, lastSlash + 1),
    base: normalized.slice(lastSlash + 1),
  };
}

export function changeMarker(kind: ChangedFileChangeKind): { letter: string; color: string } {
  switch (kind) {
    case "created":
      return { letter: "A", color: cliTheme.diff.added };
    case "untracked":
      return { letter: "U", color: cliTheme.diff.added };
    case "deleted":
      return { letter: "D", color: cliTheme.diff.removed };
    case "renamed":
      return { letter: "R", color: cliTheme.semantic.warning };
    default:
      return { letter: "M", color: cliTheme.semantic.warning };
  }
}

export function changeKindLabel(kind: ChangedFileChangeKind): string {
  switch (kind) {
    case "created":
      return "created";
    case "untracked":
      return "untracked";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
}

/**
 * Centered, muted placeholder for an empty or loading pane — a glyph over a
 * caption — so blank panes read as intentional rather than broken.
 */
export function PanePlaceholder({ glyph, label }: { glyph: string; label: string }) {
  return (
    <box
      width="100%"
      height="100%"
      flexGrow={1}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      gap={space.xs}
    >
      <text fg={cliTheme.text.muted}>{glyph}</text>
      <text {...typeRole("caption")}>{label}</text>
    </box>
  );
}

// ── Tab bar ────────────────────────────────────────────────────────────────
