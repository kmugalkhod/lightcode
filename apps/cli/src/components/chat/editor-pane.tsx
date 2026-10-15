import { useState } from "react";
import { borderStyleFor, cliTheme, space, typeRole } from "../../ui/cli-theme";
import { activeGlyphs } from "../../ui/cli-theme-capabilities";
import { codeSyntaxStyle, inferFiletype } from "../../ui/code-syntax-style";
import { fileTypeStyle } from "../../ui/file-type-style";
import { Breadcrumb } from "./breadcrumb";
import { ChatDiffCard } from "./chat-diff-card";
import { FileEditor } from "./file-editor";
import type { FileContentState } from "./use-file-content";
import type { ChangedFile } from "./use-changed-files";
import { PANEL_DIFF_MAX_LINES, ELLIPSIS, CLOSE_GLYPH, CARET_CLOSED, splitPath, changeKindLabel, PanePlaceholder } from "./explorer-shared";
import type { FileViewMode } from "./explorer-shared";

export function FileViewToggle({
  showingDiff,
  onToggle,
  editLabel = false,
}: {
  showingDiff: boolean;
  onToggle: () => void;
  editLabel?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const label = editLabel ? "✎ edit" : showingDiff ? "view file" : "view diff";
  return (
    <box
      paddingX={1}
      backgroundColor={hovered ? cliTheme.overlay.hoverBackground : "transparent"}
      onMouseDown={onToggle}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <text fg={hovered ? cliTheme.text.primary : cliTheme.accent.softText}>{label}</text>
    </box>
  );
}

export function DiffLayoutToggle({
  layout,
  onToggle,
}: {
  layout: "unified" | "split";
  onToggle: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const label = layout === "unified" ? "split" : "unified";
  return (
    <box
      paddingX={1}
      backgroundColor={hovered ? cliTheme.overlay.hoverBackground : "transparent"}
      onMouseDown={onToggle}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <text fg={hovered ? cliTheme.text.primary : cliTheme.accent.softText}>{label}</text>
    </box>
  );
}

/**
 * Read-only code view with a left line-number gutter (muted numbers on
 * surfaces.inset) so plain content and the unified diff read consistently.
 */
export function CodeWithGutter({ path, content }: { path: string; content: string }) {
  const text = content || " ";
  const lineCount = text.split("\n").length;
  const gutterWidth = String(lineCount).length;
  return (
    <box flexDirection="row" width="100%">
      <box flexShrink={0} flexDirection="column" paddingX={1} backgroundColor={cliTheme.surfaces.inset}>
        {Array.from({ length: lineCount }, (_, index) => (
          <text key={index} fg={cliTheme.text.muted}>
            {String(index + 1).padStart(gutterWidth, " ")}
          </text>
        ))}
      </box>
      <box flexGrow={1} paddingX={1}>
        <code content={text} filetype={inferFiletype(path)} syntaxStyle={codeSyntaxStyle} />
      </box>
    </box>
  );
}

export function FileEditorView({
  openFilePath,
  changedFile,
  fileContent,
  fileView,
  onToggleFileView,
  canEdit,
  onEnterEdit,
}: {
  openFilePath: string | null;
  changedFile: ChangedFile | undefined;
  fileContent: FileContentState;
  fileView: FileViewMode;
  onToggleFileView: () => void;
  canEdit: boolean;
  onEnterEdit?: () => void;
}) {
  const [diffLayout, setDiffLayout] = useState<"unified" | "split">("unified");

  if (!openFilePath) {
    return <PanePlaceholder glyph={CARET_CLOSED} label="Select a file to view its contents" />;
  }

  const showDiff = Boolean(changedFile && fileView === "diff" && changedFile.diff.trim());

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
        borderColor={cliTheme.borders.subtle}
      >
        <box flexShrink={1} height={1} overflow="hidden">
          <Breadcrumb path={openFilePath} />
        </box>
        <box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
          {changedFile ? (
            <>
              <text {...typeRole("caption")}>{changeKindLabel(changedFile.changeKind)}</text>
              {showDiff ? (
                <DiffLayoutToggle
                  layout={diffLayout}
                  onToggle={() =>
                    setDiffLayout((current) =>
                      current === "unified" ? "split" : "unified",
                    )
                  }
                />
              ) : null}
              <FileViewToggle showingDiff={showDiff} onToggle={onToggleFileView} />
            </>
          ) : fileContent.truncated ? (
            <text {...typeRole("caption")}>truncated</text>
          ) : null}
          {canEdit ? (
            <FileViewToggle showingDiff={false} onToggle={onEnterEdit ?? (() => {})} editLabel />
          ) : null}
        </box>
      </box>
      <scrollbox
        width="100%"
        height="100%"
        flexGrow={1}
        scrollY
        scrollbarOptions={{
          trackOptions: {
            foregroundColor: cliTheme.scroll.thumb,
            backgroundColor: cliTheme.scroll.rail,
          },
        }}
      >
        {showDiff && changedFile ? (
          <ChatDiffCard
            path={changedFile.path}
            diff={changedFile.diff}
            maxLines={PANEL_DIFF_MAX_LINES}
            hideHeader
            bare
            view={diffLayout}
          />
        ) : fileContent.loading ? (
          <PanePlaceholder glyph={activeGlyphs.statusDot} label={`Loading${ELLIPSIS}`} />
        ) : fileContent.error ? (
          <box paddingX={1} paddingY={1}>
            <text fg={cliTheme.semantic.error}>{fileContent.error}</text>
          </box>
        ) : (
          <CodeWithGutter path={openFilePath} content={fileContent.content} />
        )}
      </scrollbox>
    </box>
  );
}

/** A file can be edited when it's open, fully loaded, and not binary. */
export function fileIsEditable(openFilePath: string | null, fileContent: FileContentState): boolean {
  return Boolean(
    openFilePath &&
      fileContent.path === openFilePath &&
      !fileContent.loading &&
      !fileContent.error,
  );
}

export function EditorTab({
  path,
  active,
  dirty,
  onSelect,
  onClose,
}: {
  path: string;
  active: boolean;
  dirty: boolean;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [closeHovered, setCloseHovered] = useState(false);
  const base = splitPath(path).base;
  const typeStyle = fileTypeStyle(path);
  const background = active
    ? cliTheme.accent.softBackground
    : hovered
      ? cliTheme.overlay.hoverBackground
      : "transparent";

  return (
    // flexShrink 0 + no-wrap text: a crowded strip clips at its right edge
    // instead of squeezing every tab into a wrapped two-line jumble.
    <box
      flexDirection="row"
      alignItems="center"
      flexShrink={0}
      gap={1}
      paddingX={1}
      backgroundColor={background}
      onMouseDown={() => onSelect(path)}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <text wrapMode="none" truncate fg={active ? typeStyle.color : cliTheme.text.muted}>{typeStyle.tag}</text>
      <text wrapMode="none" truncate fg={active ? cliTheme.text.primary : cliTheme.text.secondary}>{base}</text>
      <box
        onMouseDown={(event: { stopPropagation?: () => void }) => {
          event.stopPropagation?.();
          onClose(path);
        }}
        onMouseOver={() => setCloseHovered(true)}
        onMouseOut={() => setCloseHovered(false)}
      >
        <text fg={dirty ? cliTheme.accent.primary : closeHovered ? cliTheme.text.primary : cliTheme.text.muted}>
          {dirty ? activeGlyphs.statusDot : CLOSE_GLYPH}
        </text>
      </box>
    </box>
  );
}

export function EditorTabStrip({
  openFiles,
  activeFilePath,
  dirty,
  onSelect,
  onClose,
}: {
  openFiles: string[];
  activeFilePath: string | null;
  dirty: boolean;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  return (
    <box
      flexDirection="row"
      alignItems="center"
      flexShrink={0}
      height={2}
      overflow="hidden"
      borderStyle={borderStyleFor.chrome}
      border={["bottom"]}
      borderColor={cliTheme.borders.subtle}
      backgroundColor={cliTheme.surfaces.panel}
    >
      {openFiles.map((path) => (
        <EditorTab
          key={path}
          path={path}
          active={path === activeFilePath}
          dirty={dirty && path === activeFilePath}
          onSelect={onSelect}
          onClose={onClose}
        />
      ))}
    </box>
  );
}

/** Editor area: tab strip + breadcrumb + editable buffer / read-only viewer. */
export function EditorPane({
  openFiles,
  activeFilePath,
  changedFiles,
  fileContent,
  fileView,
  onToggleFileView,
  editing,
  cwd,
  onExitEdit,
  onSavedEdit,
  notify,
  onSelectFileTab,
  onCloseFileTab,
  onEnterEdit,
}: {
  openFiles: string[];
  activeFilePath: string | null;
  changedFiles: ChangedFile[];
  fileContent: FileContentState;
  fileView: FileViewMode;
  onToggleFileView: () => void;
  editing: boolean;
  cwd: string;
  onExitEdit: () => void;
  onSavedEdit: (path: string) => void;
  notify: (text: string, tone?: "info" | "error") => void;
  onSelectFileTab: (path: string) => void;
  onCloseFileTab: (path: string) => void;
  onEnterEdit?: () => void;
}) {
  const openChangedFile = activeFilePath
    ? changedFiles.find((file) => file.path === activeFilePath)
    : undefined;
  const canEdit = fileIsEditable(activeFilePath, fileContent);
  const isEditing = editing && canEdit && activeFilePath !== null;

  return (
    <>
      {openFiles.length > 0 ? (
        <EditorTabStrip
          openFiles={openFiles}
          activeFilePath={activeFilePath}
          dirty={isEditing}
          onSelect={onSelectFileTab}
          onClose={onCloseFileTab}
        />
      ) : null}
      {isEditing && activeFilePath ? (
        <FileEditor
          key={activeFilePath}
          path={activeFilePath}
          initialContent={fileContent.content}
          cwd={cwd}
          onExit={onExitEdit}
          onSaved={onSavedEdit}
          notify={notify}
        />
      ) : (
        <FileEditorView
          openFilePath={activeFilePath}
          changedFile={openChangedFile}
          fileContent={fileContent}
          fileView={fileView}
          onToggleFileView={onToggleFileView}
          canEdit={canEdit}
          onEnterEdit={onEnterEdit}
        />
      )}
    </>
  );
}

// ── Panel shell ──────────────────────────────────────────────────────────────
