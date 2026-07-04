import {
  getTreeSitterClient,
  type LineNumberRenderable,
  type TextareaRenderable,
} from "@opentui/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { borderStyleFor, cliTheme } from "../../ui/cli-theme";
import { activeGlyphs } from "../../ui/cli-theme-capabilities";
import { codeSyntaxStyle, inferFiletype } from "../../ui/code-syntax-style";
import { Breadcrumb } from "./breadcrumb";

/** Lazily load the (heavy) AI runtime once and reuse the module. */
let runtimePromise: Promise<typeof import("@lightcode/ai/runtime")> | null = null;
function loadRuntime() {
  runtimePromise ??= import("@lightcode/ai/runtime");
  return runtimePromise;
}

/** Debounce (ms) between the last keystroke and a re-highlight pass. */
const HIGHLIGHT_DEBOUNCE_MS = 120;
/** Soft indentation inserted by the Tab key, matching the repo style. */
const TAB_SPACES = "  ";

interface FileEditorKeyEvent {
  name: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

interface FileEditorProps {
  /** Workspace-relative path being edited. */
  path: string;
  /** File contents to seed the buffer with (already loaded). */
  initialContent: string;
  cwd: string;
  /** Leave edit mode (return to the read-only view). */
  onExit: () => void;
  /** Called after a successful save so callers can refresh views (git, content). */
  onSaved: (path: string) => void;
  notify: (text: string, tone?: "info" | "error") => void;
}

/**
 * A self-contained, editable code buffer for the Explorer panel. The focused
 * `<textarea>` owns its keys: it handles Ctrl+S (save), Esc (exit) and Tab
 * (soft indent) in its own onKeyDown so the global keyboard handler never
 * fights it. Saving writes the whole file via the runtime's write tool (safe
 * within the workspace).
 *
 * The buffer is dressed like a real editor: a native line-number gutter
 * (`<line-number>` tracks the buffer's scroll and wrapping exactly), live
 * tree-sitter highlighting re-parsed on a short debounce, a current-line
 * gutter highlight, and a breadcrumb header carrying Ln/Col and save hints.
 */
export function FileEditor({
  path,
  initialContent,
  cwd,
  onExit,
  onSaved,
  notify,
}: FileEditorProps) {
  const textareaRef = useRef<TextareaRenderable>(null);
  const gutterRef = useRef<LineNumberRenderable>(null);
  // The content last persisted (or the seed) — used to tell "dirty" apart from
  // the initial buffer load, which itself fires a content-change event.
  const savedContentRef = useRef(initialContent);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // First Esc with unsaved edits asks for confirmation; second discards.
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [cursor, setCursor] = useState({ line: 0, col: 0 });
  const activeLineRef = useRef(-1);

  const filetype = inferFiletype(path);

  // ── Live syntax highlighting ──────────────────────────────────────────────
  // The editable buffer has no built-in tree-sitter pipeline (unlike <code>),
  // so we run the shared client's one-shot highlighter over the whole buffer
  // and repaint char-range highlights. A sequence guard drops stale passes.
  const highlightSeq = useRef(0);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyHighlights = useCallback(async () => {
    const target = textareaRef.current;
    if (!target || !filetype) {
      return;
    }
    const seq = ++highlightSeq.current;
    try {
      const result = await getTreeSitterClient().highlightOnce(target.plainText, filetype);
      const current = textareaRef.current;
      if (seq !== highlightSeq.current || !current || !result.highlights) {
        return;
      }
      current.clearAllHighlights();
      for (const [start, end, group] of result.highlights) {
        if (start >= end) {
          continue;
        }
        // getStyleId falls back from dotted scopes ("keyword.return" → "keyword").
        const styleId = codeSyntaxStyle.getStyleId(group);
        if (styleId === null) {
          continue;
        }
        current.addHighlightByCharRange({ start, end, styleId });
      }
    } catch {
      // Highlighting is progressive enhancement — plain text on any failure.
    }
  }, [filetype]);

  const scheduleHighlight = useCallback(() => {
    if (highlightTimer.current) {
      clearTimeout(highlightTimer.current);
    }
    highlightTimer.current = setTimeout(() => {
      void applyHighlights();
    }, HIGHLIGHT_DEBOUNCE_MS);
  }, [applyHighlights]);

  // ── Cursor tracking (Ln/Col + current-line highlight) ─────────────────────
  const syncCursor = useCallback(() => {
    const target = textareaRef.current;
    if (!target) {
      return;
    }
    const logical = target.logicalCursor;
    setCursor((previous) =>
      previous.line === logical.row && previous.col === logical.col
        ? previous
        : { line: logical.row, col: logical.col },
    );
    if (logical.row !== activeLineRef.current) {
      const gutter = gutterRef.current;
      if (gutter) {
        if (activeLineRef.current >= 0) {
          gutter.clearLineColor(activeLineRef.current);
        }
        gutter.setLineColor(logical.row, {
          gutter: cliTheme.surfaces.elevated,
          content: cliTheme.surfaces.elevated,
        });
      }
      activeLineRef.current = logical.row;
    }
  }, []);

  useEffect(() => {
    // The focused prop alone doesn't reclaim focus when edit mode is re-entered
    // after a previous editor unmounted (renderer focus stays elsewhere).
    textareaRef.current?.focus();
    void applyHighlights();
    syncCursor();
    // onCursorChange doesn't fire for plain cursor motion (only edits), so a
    // light poll keeps Ln/Col and the current-line highlight fresh; syncCursor
    // bails out of setState when nothing moved.
    const cursorTimer = setInterval(syncCursor, 150);
    return () => {
      clearInterval(cursorTimer);
      if (highlightTimer.current) {
        clearTimeout(highlightTimer.current);
      }
    };
  }, [applyHighlights, syncCursor]);

  const save = useCallback(async () => {
    const content = textareaRef.current?.plainText ?? "";
    setSaving(true);
    try {
      const runtime = await loadRuntime();
      const context = runtime.createWorkspaceContext(cwd);
      await runtime.executeWriteFile({ path, content, overwrite: true }, context);
      savedContentRef.current = content;
      setDirty(false);
      setConfirmingDiscard(false);
      notify(`Saved ${path}`);
      onSaved(path);
    } catch (caught) {
      notify(
        `Save failed: ${caught instanceof Error ? caught.message : "unknown error"}`,
        "error",
      );
    } finally {
      setSaving(false);
    }
  }, [cwd, notify, onSaved, path]);

  const handleContentChange = useCallback(() => {
    const current = textareaRef.current?.plainText ?? "";
    setDirty(current !== savedContentRef.current);
    scheduleHighlight();
    syncCursor();
  }, [scheduleHighlight, syncCursor]);

  const handleKeyDown = useCallback(
    (event: FileEditorKeyEvent) => {
      // Ctrl+S — save.
      if (event.name === "s" && event.ctrl && !event.meta) {
        event.preventDefault();
        event.stopPropagation();
        void save();
        return;
      }
      // Esc — exit (guarded by a confirm step when there are unsaved edits).
      if (event.name === "escape") {
        event.preventDefault();
        event.stopPropagation();
        if (dirty && !confirmingDiscard) {
          setConfirmingDiscard(true);
          return;
        }
        onExit();
        return;
      }
      // Tab — soft indent, so the key edits instead of moving focus.
      if (event.name === "tab" && !event.ctrl && !event.meta && !event.shift) {
        event.preventDefault();
        event.stopPropagation();
        textareaRef.current?.insertText(TAB_SPACES);
        handleContentChange();
        return;
      }
      // Any other key cancels a pending discard confirmation and edits normally.
      if (confirmingDiscard) {
        setConfirmingDiscard(false);
      }
    },
    [confirmingDiscard, dirty, handleContentChange, onExit, save],
  );

  const statusText = confirmingDiscard
    ? "Unsaved changes — Esc again to discard, Ctrl+S to save"
    : saving
      ? "Saving…"
      : "Ctrl+S save · Esc exit";

  const languageLabel = filetype ?? "plain text";

  return (
    <box width="100%" flexGrow={1} flexDirection="column">
      <box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        flexShrink={0}
        gap={2}
        paddingX={1}
        borderStyle={borderStyleFor.chrome}
        border={["bottom"]}
        borderColor={confirmingDiscard ? cliTheme.semantic.warning : cliTheme.borders.subtle}
      >
        <box flexShrink={1} height={1} overflow="hidden">
          <Breadcrumb path={path} />
        </box>
        {/* Ln/Col + language + save hints live up here: the top chrome row is
            the only strip this pane can render reliably (see the note below on
            the yoga phantom row that breaks a bottom mode line). */}
        <text wrapMode="none" truncate>
          {dirty ? (
            <span fg={cliTheme.accent.primary}>{`${activeGlyphs.statusDot} `}</span>
          ) : null}
          <span fg={cliTheme.text.secondary}>
            {`Ln ${cursor.line + 1}, Col ${cursor.col + 1}`}
          </span>
          <span fg={cliTheme.text.muted}>{`  ${languageLabel}  ·  `}</span>
          <span fg={confirmingDiscard ? cliTheme.semantic.warning : cliTheme.text.muted}>
            {statusText}
          </span>
        </text>
      </box>

      {/* The gutter renderable owns both columns: it draws line numbers from the
          buffer's own visual-line map, so numbers can never drift from content.
          It measures itself against the whole buffer, so the clipping wrapper
          with flexBasis 0 pins it to exactly the rows below the header.
          NOTE: keep this the LAST child — a yoga quirk places any sibling after
          the measured line-number one row too low (onto the card's bottom
          border), which is why Ln/Col lives in the header instead of a footer. */}
      <box
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minHeight={0}
        flexDirection="column"
        overflow="hidden"
      >
        <line-number
          ref={gutterRef}
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          minHeight={0}
          fg={cliTheme.text.muted}
          bg={cliTheme.surfaces.panel}
          minWidth={4}
          paddingRight={1}
        >
          <textarea
            ref={textareaRef}
            initialValue={initialContent}
            onKeyDown={handleKeyDown}
            onContentChange={handleContentChange}
            onCursorChange={syncCursor}
            focused
            flexGrow={1}
            flexShrink={1}
            wrapMode="none"
            syntaxStyle={codeSyntaxStyle}
            backgroundColor={cliTheme.surfaces.inset}
            focusedBackgroundColor={cliTheme.surfaces.inset}
            textColor={cliTheme.text.primary}
            cursorColor={cliTheme.accent.primary}
            selectionBg={cliTheme.accent.softBackground}
            selectionFg={cliTheme.text.primary}
          />
        </line-number>
      </box>

    </box>
  );
}
