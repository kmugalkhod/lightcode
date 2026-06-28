import { useMemo, useState } from "react";
import { borderStyleFor, cliTheme, space, typeRole } from "../../ui/cli-theme";
import { activeGlyphs, terminalCapabilities } from "../../ui/cli-theme-capabilities";
import { codeSyntaxStyle, inferFiletype } from "../../ui/code-syntax-style";
import { fileTypeStyle } from "../../ui/file-type-style";
import { useSpinner } from "../../ui/hooks/use-spinner";
import { truncatePathLeft } from "../../utils/text-utils";
import { ChatDiffCard } from "./chat-diff-card";
import { FileEditor } from "./file-editor";
import type { FileContentState } from "./use-file-content";
import type { FileTreeApi, FileTreeNode } from "./use-file-tree";
import type { ChangedFile, ChangedFileChangeKind } from "./use-changed-files";

/** Diffs under this many lines render in full in the panel's deep-look view. */
const PANEL_DIFF_MAX_LINES = 400;

const UNICODE = terminalCapabilities.unicode;
const ELLIPSIS = UNICODE ? "…" : "...";
const CLOSE_GLYPH = UNICODE ? "✕" : "x";
const NO_CHANGE_GLYPH = UNICODE ? "—" : "-";
const CARET_OPEN = UNICODE ? "▾" : "v";
const CARET_CLOSED = UNICODE ? "▸" : ">";
// One faint vertical rule per depth level, like an editor's indent guides.
const INDENT_GUIDE = UNICODE ? "│" : " ";
const FILE_GLYPH = activeGlyphs.bullet;

export type PanelTab = "files" | "changes";
export type FileViewMode = "content" | "diff";

interface FileExplorerPanelProps {
  activeTab: PanelTab;
  onSelectTab: (tab: PanelTab) => void;
  focused: boolean;
  onClose: () => void;

  // Changes tab (git working-tree)
  changedFiles: ChangedFile[];
  selectedChangePath: string | null;
  onSelectChange: (path: string) => void;
  stickToNewest: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  changesLoading: boolean;
  isRepo: boolean;
  /** Paths the agent edited this session (for a small badge). */
  agentTouched: ReadonlySet<string>;

  // Files tab
  tree: FileTreeApi;
  fileContent: FileContentState;
  fileView: FileViewMode;
  onToggleFileView: () => void;
  /** Absolute path of the project root shown by the tree (current directory). */
  rootPath: string;
  // Editing (Files tab)
  editing: boolean;
  cwd: string;
  onExitEdit: () => void;
  onSavedEdit: (path: string) => void;
  notify: (text: string, tone?: "info" | "error") => void;
  // Open-file tabs (Files tab)
  openFiles: string[];
  activeFilePath: string | null;
  onSelectFileTab: (path: string) => void;
  onCloseFileTab: (path: string) => void;
}

function splitPath(path: string): { dir: string; base: string } {
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

function changeMarker(kind: ChangedFileChangeKind): { letter: string; color: string } {
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

function changeKindLabel(kind: ChangedFileChangeKind): string {
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
function PanePlaceholder({ glyph, label }: { glyph: string; label: string }) {
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

export function TabButton({
  label,
  active,
  onPress,
  underline = false,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  /** Editor-tab styling: an accent underline marks the active tab (IDE header). */
  underline?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <box
      paddingX={1}
      backgroundColor={
        active
          ? cliTheme.accent.softBackground
          : hovered
            ? cliTheme.overlay.hoverBackground
            : "transparent"
      }
      borderStyle={underline ? borderStyleFor.chrome : undefined}
      border={underline ? ["bottom"] : undefined}
      borderColor={
        underline
          ? active
            ? cliTheme.accent.primary
            : cliTheme.surfaces.panel
          : undefined
      }
      onMouseDown={onPress}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <text
        fg={active ? cliTheme.accent.primary : cliTheme.text.muted}
        attributes={active ? typeRole("section").attributes : undefined}
      >
        {label}
      </text>
    </box>
  );
}

// ── Changes tab rows ─────────────────────────────────────────────────────────

function ChangedFileRow({
  file,
  selected,
  agentTouched,
  onSelect,
}: {
  file: ChangedFile;
  selected: boolean;
  agentTouched?: boolean;
  onSelect: (path: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const isStreaming = file.status === "streaming";
  const spinner = useSpinner({
    active: isStreaming,
    reducedMotion: terminalCapabilities.reducedMotion,
    ascii: !terminalCapabilities.unicode,
  });
  const marker = changeMarker(file.changeKind);
  const { dir, base } = splitPath(file.path);
  const shownDir = dir ? truncatePathLeft(dir, 22, ELLIPSIS) : "";

  const background = selected
    ? cliTheme.surfaces.elevated
    : hovered
      ? cliTheme.overlay.hoverBackground
      : "transparent";

  return (
    <box
      flexDirection="row"
      alignItems="center"
      backgroundColor={background}
      borderStyle={borderStyleFor.chrome}
      border={["left"]}
      borderColor={selected ? cliTheme.accent.primary : background}
      onMouseDown={() => onSelect(file.path)}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        flexGrow={1}
        paddingX={1}
      >
        <box flexDirection="row" alignItems="center" gap={1} flexShrink={1}>
          <text fg={isStreaming ? cliTheme.accent.primary : marker.color}>
            {isStreaming ? spinner : marker.letter}
          </text>
          <text>
            {shownDir ? <span fg={cliTheme.text.muted}>{shownDir}</span> : null}
            <span fg={cliTheme.text.primary} attributes={typeRole("section").attributes}>
              {base}
            </span>
          </text>
          {agentTouched ? (
            <text fg={cliTheme.accent.primary}>{activeGlyphs.statusDot}</text>
          ) : null}
        </box>
        <box flexDirection="row" alignItems="center" gap={1}>
          {isStreaming ? (
            <text fg={cliTheme.text.muted}>{`writing${ELLIPSIS}`}</text>
          ) : (
            <>
              {file.addedLines > 0 ? (
                <text fg={cliTheme.diff.added}>{`+${file.addedLines}`}</text>
              ) : null}
              {file.removedLines > 0 ? (
                <text fg={cliTheme.diff.removed}>{`-${file.removedLines}`}</text>
              ) : null}
              {file.addedLines === 0 && file.removedLines === 0 ? (
                <text fg={cliTheme.text.muted}>{NO_CHANGE_GLYPH}</text>
              ) : null}
            </>
          )}
        </box>
      </box>
    </box>
  );
}

function GitBranchHeader({
  branch,
  ahead,
  behind,
  loading,
}: {
  branch: string | null;
  ahead: number;
  behind: number;
  loading: boolean;
}) {
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      alignItems="center"
      paddingX={1}
      borderStyle={borderStyleFor.chrome}
      border={["bottom"]}
      borderColor={cliTheme.borders.subtle}
    >
      <box flexDirection="row" alignItems="center" gap={1}>
        <text {...typeRole("section")}>{branch ?? "(detached)"}</text>
        {ahead > 0 ? <text {...typeRole("caption")}>{`↑${ahead}`}</text> : null}
        {behind > 0 ? <text {...typeRole("caption")}>{`↓${behind}`}</text> : null}
      </box>
      <text {...typeRole("caption")}>{loading ? `refreshing${ELLIPSIS}` : "r refresh"}</text>
    </box>
  );
}

export function ChangesTab({
  changedFiles,
  selectedChangePath,
  onSelectChange,
  stickToNewest,
  focused,
  branch,
  ahead,
  behind,
  loading,
  isRepo,
  agentTouched,
  listOnly = false,
}: {
  changedFiles: ChangedFile[];
  selectedChangePath: string | null;
  onSelectChange: (path: string) => void;
  stickToNewest: boolean;
  focused: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  loading: boolean;
  isRepo: boolean;
  agentTouched: ReadonlySet<string>;
  /**
   * Render only the file list (no inline diff pane). Used by the IDE sidebar,
   * where the diff opens full-width in the center editor pane instead.
   */
  listOnly?: boolean;
}) {
  const selectedFile =
    changedFiles.find((file) => file.path === selectedChangePath) ?? null;
  const selectedIsUntracked = selectedFile?.changeKind === "untracked";
  const showDiff = Boolean(selectedFile && selectedFile.diff.trim().length > 0);
  // Untracked files have no git diff; show a detail pane with a note instead.
  // In list-only mode the inline detail pane is suppressed entirely.
  const showDetail = !listOnly && (showDiff || selectedIsUntracked);

  return (
    <>
      <box
        width="100%"
        flexGrow={showDetail ? undefined : 1}
        height={showDetail ? "42%" : undefined}
        flexShrink={0}
        flexDirection="column"
        borderStyle={borderStyleFor.card}
        borderColor={focused ? cliTheme.borders.active : cliTheme.borders.default}
        backgroundColor={cliTheme.surfaces.inset}
      >
        {isRepo ? <GitBranchHeader branch={branch} ahead={ahead} behind={behind} loading={loading} /> : null}
        {!isRepo ? (
          <box paddingX={1} paddingY={1}>
            <text {...typeRole("secondary")}>Not a git repository.</text>
          </box>
        ) : changedFiles.length === 0 ? (
          <box paddingX={1} paddingY={1}>
            <text {...typeRole("secondary")}>{loading ? `Loading${ELLIPSIS}` : "No changes."}</text>
          </box>
        ) : (
          <scrollbox
            width="100%"
            height="100%"
            flexGrow={1}
            paddingY={1}
            scrollY
            stickyScroll={stickToNewest}
            stickyStart="bottom"
            contentOptions={{ width: "100%", flexDirection: "column", gap: space.xs }}
            scrollbarOptions={{
              trackOptions: {
                foregroundColor: cliTheme.scroll.thumb,
                backgroundColor: cliTheme.scroll.rail,
              },
            }}
          >
            {changedFiles.map((file) => (
              <ChangedFileRow
                key={file.path}
                file={file}
                selected={selectedFile?.path === file.path}
                agentTouched={agentTouched.has(file.path)}
                onSelect={onSelectChange}
              />
            ))}
          </scrollbox>
        )}
      </box>

      {showDetail && selectedFile ? (
        <box
          width="100%"
          flexGrow={1}
          flexDirection="column"
          borderStyle={borderStyleFor.card}
          borderColor={cliTheme.borders.subtle}
          backgroundColor={cliTheme.surfaces.inset}
        >
          <box
            flexDirection="row"
            justifyContent="space-between"
            alignItems="center"
            paddingX={1}
            borderStyle={borderStyleFor.chrome}
            border={["bottom"]}
            borderColor={cliTheme.borders.subtle}
          >
            <text {...typeRole("section")}>{truncatePathLeft(selectedFile.path, 36, ELLIPSIS)}</text>
            <text {...typeRole("caption")}>{changeKindLabel(selectedFile.changeKind)}</text>
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
            {showDiff ? (
              <ChatDiffCard
                path={selectedFile.path}
                diff={selectedFile.diff}
                maxLines={PANEL_DIFF_MAX_LINES}
                hideHeader
                bare
              />
            ) : (
              <box paddingX={1} paddingY={1}>
                <text {...typeRole("secondary")}>
                  Untracked file — open it in the Files tab to view its contents.
                </text>
              </box>
            )}
          </scrollbox>
        </box>
      ) : null}
    </>
  );
}

// ── Files tab ────────────────────────────────────────────────────────────────

function TreeRow({
  node,
  selected,
  changeKind,
  onSelect,
  onToggleDir,
}: {
  node: FileTreeNode;
  selected: boolean;
  changeKind: ChangedFileChangeKind | undefined;
  onSelect: (path: string) => void;
  onToggleDir: (path: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const marker = changeKind ? changeMarker(changeKind) : null;

  const background = selected
    ? cliTheme.surfaces.elevated
    : hovered
      ? cliTheme.overlay.hoverBackground
      : "transparent";

  const caret = node.isDir
    ? node.loading
      ? activeGlyphs.statusDot
      : node.expanded
        ? CARET_OPEN
        : CARET_CLOSED
    : FILE_GLYPH;
  // Directories keep a muted caret; files take their type hue so the tree
  // scans by color the way an icon theme would.
  const leadColor = node.isDir ? cliTheme.text.muted : fileTypeStyle(node.path).color;

  return (
    <box
      flexDirection="row"
      alignItems="center"
      backgroundColor={background}
      borderStyle={borderStyleFor.chrome}
      border={["left"]}
      borderColor={selected ? cliTheme.accent.primary : background}
      paddingLeft={1}
      paddingRight={1}
      onMouseDown={() => {
        onSelect(node.path);
        if (node.isDir) {
          onToggleDir(node.path);
        }
      }}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <box flexDirection="row" alignItems="center" flexGrow={1} flexShrink={1}>
        {Array.from({ length: node.depth }, (_, level) => (
          <text key={level} fg={cliTheme.borders.subtle}>{`${INDENT_GUIDE} `}</text>
        ))}
        <text fg={leadColor}>{`${caret} `}</text>
        <text
          fg={node.isDir ? cliTheme.accent.softText : cliTheme.text.primary}
          attributes={node.isDir ? typeRole("section").attributes : undefined}
        >
          {node.isDir ? `${node.name}/` : node.name}
        </text>
      </box>
      {marker ? <text fg={marker.color}>{marker.letter}</text> : null}
    </box>
  );
}

function FileViewToggle({
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

function DiffLayoutToggle({
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
function CodeWithGutter({ path, content }: { path: string; content: string }) {
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

function FileEditorView({
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
        paddingX={1}
        borderStyle={borderStyleFor.chrome}
        border={["bottom"]}
        borderColor={cliTheme.borders.subtle}
      >
        <text {...typeRole("section")}>{truncatePathLeft(openFilePath, 26, ELLIPSIS)}</text>
        <box flexDirection="row" alignItems="center" gap={1}>
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
function fileIsEditable(openFilePath: string | null, fileContent: FileContentState): boolean {
  return Boolean(
    openFilePath &&
      fileContent.path === openFilePath &&
      !fileContent.loading &&
      !fileContent.error,
  );
}

function EditorTab({
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
    ? cliTheme.surfaces.inset
    : hovered
      ? cliTheme.overlay.hoverBackground
      : "transparent";

  return (
    <box
      flexDirection="row"
      alignItems="center"
      gap={1}
      paddingX={1}
      backgroundColor={background}
      borderStyle={borderStyleFor.chrome}
      border={["bottom"]}
      borderColor={active ? cliTheme.accent.primary : background}
      onMouseDown={() => onSelect(path)}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <text fg={active ? typeStyle.color : cliTheme.text.muted}>{typeStyle.tag}</text>
      <text fg={active ? cliTheme.text.primary : cliTheme.text.secondary}>{base}</text>
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

function EditorTabStrip({
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

/** VS Code-style breadcrumb: src › graph › file.ts */
function Breadcrumb({ path }: { path: string }) {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return (
    <box
      flexDirection="row"
      alignItems="center"
      gap={1}
      paddingX={1}
      flexShrink={0}
      borderStyle={borderStyleFor.chrome}
      border={["bottom"]}
      borderColor={cliTheme.borders.subtle}
      backgroundColor={cliTheme.surfaces.panel}
    >
      {segments.map((segment, index) => (
        <box key={`${segment}-${index}`} flexDirection="row" alignItems="center" gap={1}>
          {index > 0 ? <text fg={cliTheme.text.muted}>{activeGlyphs.breadcrumb}</text> : null}
          <text
            fg={index === segments.length - 1 ? cliTheme.text.secondary : cliTheme.text.muted}
          >
            {segment}
          </text>
        </box>
      ))}
    </box>
  );
}

function FilesTab({
  tree,
  changedByPath,
  changedFiles,
  fileContent,
  fileView,
  onToggleFileView,
  rootPath,
  focused,
  editing,
  cwd,
  onExitEdit,
  onSavedEdit,
  notify,
  openFiles,
  activeFilePath,
  onSelectFileTab,
  onCloseFileTab,
}: {
  tree: FileTreeApi;
  changedByPath: Map<string, ChangedFileChangeKind>;
  changedFiles: ChangedFile[];
  fileContent: FileContentState;
  fileView: FileViewMode;
  onToggleFileView: () => void;
  rootPath: string;
  focused: boolean;
  editing: boolean;
  cwd: string;
  onExitEdit: () => void;
  onSavedEdit: (path: string) => void;
  notify: (text: string, tone?: "info" | "error") => void;
  openFiles: string[];
  activeFilePath: string | null;
  onSelectFileTab: (path: string) => void;
  onCloseFileTab: (path: string) => void;
}) {
  return (
    <>
      <box
        width="100%"
        height="42%"
        flexShrink={0}
        flexDirection="column"
        borderStyle={borderStyleFor.card}
        borderColor={focused ? cliTheme.borders.active : cliTheme.borders.default}
        backgroundColor={cliTheme.surfaces.inset}
      >
        <ExplorerTree tree={tree} changedByPath={changedByPath} rootPath={rootPath} />
      </box>

      <box
        width="100%"
        flexGrow={1}
        flexDirection="column"
        borderStyle={borderStyleFor.card}
        borderColor={cliTheme.borders.subtle}
        backgroundColor={cliTheme.surfaces.inset}
      >
        <EditorPane
          openFiles={openFiles}
          activeFilePath={activeFilePath}
          changedFiles={changedFiles}
          fileContent={fileContent}
          fileView={fileView}
          onToggleFileView={onToggleFileView}
          editing={editing}
          cwd={cwd}
          onExitEdit={onExitEdit}
          onSavedEdit={onSavedEdit}
          notify={notify}
          onSelectFileTab={onSelectFileTab}
          onCloseFileTab={onCloseFileTab}
        />
      </box>
    </>
  );
}

/** Project file tree (root header + lazy tree rows). Reused as the IDE left pane. */
export function ExplorerTree({
  tree,
  changedByPath,
  rootPath,
}: {
  tree: FileTreeApi;
  changedByPath: Map<string, ChangedFileChangeKind>;
  rootPath: string;
}) {
  const rootName =
    rootPath.replaceAll("\\", "/").replace(/\/$/, "").split("/").pop() || rootPath;

  return (
    <>
      <box
        flexDirection="row"
        alignItems="center"
        gap={1}
        paddingX={1}
        borderStyle={borderStyleFor.chrome}
        border={["bottom"]}
        borderColor={cliTheme.borders.subtle}
      >
        <text fg={cliTheme.accent.primary}>{CARET_OPEN}</text>
        <text {...typeRole("section")}>{`${rootName}/`}</text>
      </box>
      {tree.rootLoading && tree.nodes.length === 0 ? (
        <PanePlaceholder glyph={activeGlyphs.statusDot} label={`Loading project${ELLIPSIS}`} />
      ) : tree.error && tree.nodes.length === 0 ? (
        <box paddingX={1} paddingY={1}>
          <text fg={cliTheme.semantic.error}>{tree.error}</text>
        </box>
      ) : (
        <scrollbox
          width="100%"
          height="100%"
          flexGrow={1}
          paddingY={1}
          scrollY
          contentOptions={{ width: "100%", flexDirection: "column" }}
          scrollbarOptions={{
            trackOptions: {
              foregroundColor: cliTheme.scroll.thumb,
              backgroundColor: cliTheme.scroll.rail,
            },
          }}
        >
          {tree.nodes.map((node) => (
            <TreeRow
              key={node.path}
              node={node}
              selected={tree.selectedPath === node.path}
              changeKind={changedByPath.get(node.path)}
              onSelect={tree.selectPath}
              onToggleDir={tree.toggleDir}
            />
          ))}
        </scrollbox>
      )}
    </>
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
      {activeFilePath && !isEditing ? <Breadcrumb path={activeFilePath} /> : null}
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

/**
 * Right-side panel with two tabs: a full project file tree (editor-style — click
 * a file to read its whole contents) and a "Changes" view of the agent's edits.
 * Presentational: tab/selection/tree/focus state is owned by the chat screen so
 * the keyboard handler can drive it.
 */
export function FileExplorerPanel({
  activeTab,
  onSelectTab,
  focused,
  onClose,
  changedFiles,
  selectedChangePath,
  onSelectChange,
  stickToNewest,
  branch,
  ahead,
  behind,
  changesLoading,
  isRepo,
  agentTouched,
  tree,
  fileContent,
  fileView,
  onToggleFileView,
  rootPath,
  editing,
  cwd,
  onExitEdit,
  onSavedEdit,
  notify,
  openFiles,
  activeFilePath,
  onSelectFileTab,
  onCloseFileTab,
}: FileExplorerPanelProps) {
  const [closeHovered, setCloseHovered] = useState(false);

  const changedByPath = useMemo(() => {
    const map = new Map<string, ChangedFileChangeKind>();
    for (const file of changedFiles) {
      map.set(file.path, file.changeKind);
    }
    return map;
  }, [changedFiles]);

  return (
    <box width="100%" height="100%" flexDirection="column" gap={1}>
      <box
        width="100%"
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        paddingX={1}
      >
        <box flexDirection="row" alignItems="center" gap={1}>
          <TabButton
            label="Files"
            active={activeTab === "files"}
            onPress={() => onSelectTab("files")}
          />
          <TabButton
            label={`Changes${changedFiles.length > 0 ? ` ${changedFiles.length}` : ""}`}
            active={activeTab === "changes"}
            onPress={() => onSelectTab("changes")}
          />
          {focused ? (
            <text fg={cliTheme.accent.primary}>{`${activeGlyphs.statusDot} focus`}</text>
          ) : null}
        </box>
        <box
          paddingX={1}
          backgroundColor={closeHovered ? cliTheme.overlay.hoverBackground : "transparent"}
          onMouseDown={onClose}
          onMouseOver={() => setCloseHovered(true)}
          onMouseOut={() => setCloseHovered(false)}
        >
          <text fg={closeHovered ? cliTheme.text.primary : cliTheme.text.muted}>{CLOSE_GLYPH}</text>
        </box>
      </box>

      {activeTab === "files" ? (
        <FilesTab
          tree={tree}
          changedByPath={changedByPath}
          changedFiles={changedFiles}
          fileContent={fileContent}
          fileView={fileView}
          onToggleFileView={onToggleFileView}
          rootPath={rootPath}
          focused={focused}
          editing={editing}
          cwd={cwd}
          onExitEdit={onExitEdit}
          onSavedEdit={onSavedEdit}
          notify={notify}
          openFiles={openFiles}
          activeFilePath={activeFilePath}
          onSelectFileTab={onSelectFileTab}
          onCloseFileTab={onCloseFileTab}
        />
      ) : (
        <ChangesTab
          changedFiles={changedFiles}
          selectedChangePath={selectedChangePath}
          onSelectChange={onSelectChange}
          stickToNewest={stickToNewest}
          focused={focused}
          branch={branch}
          ahead={ahead}
          behind={behind}
          loading={changesLoading}
          isRepo={isRepo}
          agentTouched={agentTouched}
        />
      )}
    </box>
  );
}
