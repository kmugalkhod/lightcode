import type { TextareaRenderable } from "@opentui/core";
import { useCallback, useRef, useState } from "react";
import { cliTheme, typeRole } from "../../ui/cli-theme";
import { codeSyntaxStyle } from "../../ui/code-syntax-style";

/** Lazily load the (heavy) AI runtime once and reuse the module. */
let runtimePromise: Promise<typeof import("@lightcode/ai/runtime")> | null = null;
function loadRuntime() {
  runtimePromise ??= import("@lightcode/ai/runtime");
  return runtimePromise;
}

interface FileEditorKeyEvent {
  name: string;
  ctrl?: boolean;
  meta?: boolean;
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
 * `<textarea>` owns its keys: it handles Ctrl+S (save) and Esc (exit) in its own
 * onKeyDown so the global keyboard handler never fights it. Saving writes the
 * whole file via the runtime's write tool (safe within the workspace).
 *
 * Note: OpenTUI's editable buffer has no tree-sitter pipeline, so editing shows
 * plain (un-highlighted) text; the highlighted read-only view returns on exit.
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
  // The content last persisted (or the seed) — used to tell "dirty" apart from
  // the initial buffer load, which itself fires a content-change event.
  const savedContentRef = useRef(initialContent);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // First Esc with unsaved edits asks for confirmation; second discards.
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

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
      // Any other key cancels a pending discard confirmation and edits normally.
      if (confirmingDiscard) {
        setConfirmingDiscard(false);
      }
    },
    [confirmingDiscard, dirty, onExit, save],
  );

  const handleContentChange = useCallback(() => {
    const current = textareaRef.current?.plainText ?? "";
    setDirty(current !== savedContentRef.current);
  }, []);

  const statusText = confirmingDiscard
    ? "Unsaved changes — Esc again to discard, Ctrl+S to save"
    : saving
      ? "Saving…"
      : dirty
        ? "● unsaved · Ctrl+S save · Esc exit"
        : "Ctrl+S save · Esc exit";

  return (
    <box width="100%" flexGrow={1} flexDirection="column">
      <box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        flexShrink={0}
        paddingX={1}
        borderStyle="single"
        border={["bottom"]}
        borderColor={confirmingDiscard ? cliTheme.semantic.warning : cliTheme.borders.subtle}
      >
        <text fg={cliTheme.accent.primary} attributes={typeRole("section").attributes}>
          {dirty ? "● editing" : "editing"}
        </text>
        <text
          fg={confirmingDiscard ? cliTheme.semantic.warning : cliTheme.text.muted}
        >
          {statusText}
        </text>
      </box>
      <textarea
        ref={textareaRef}
        initialValue={initialContent}
        onKeyDown={handleKeyDown}
        onContentChange={handleContentChange}
        focused
        width="100%"
        height="100%"
        flexGrow={1}
        wrapMode="none"
        syntaxStyle={codeSyntaxStyle}
        backgroundColor={cliTheme.surfaces.inset}
        focusedBackgroundColor={cliTheme.surfaces.inset}
        textColor={cliTheme.text.primary}
        cursorColor={cliTheme.accent.primary}
      />
    </box>
  );
}
