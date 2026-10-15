import { useState } from "react";
import { borderStyleFor, cliTheme, space, typeRole } from "../../ui/cli-theme";
import { activeGlyphs, terminalCapabilities } from "../../ui/cli-theme-capabilities";
import { useSpinner } from "../../ui/hooks/use-spinner";
import { truncatePathLeft } from "../../utils/text-utils";
import { ChatDiffCard } from "./chat-diff-card";
import type { ChangedFile } from "./use-changed-files";
import { PANEL_DIFF_MAX_LINES, ELLIPSIS, NO_CHANGE_GLYPH, splitPath, changeMarker, changeKindLabel } from "./explorer-shared";

export function ChangedFileRow({
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
        {/* One text run: the marker/name spacing survives truncation, which a
            flex gap between sibling texts does not. */}
        <box flexDirection="row" alignItems="center" flexShrink={1}>
          <text wrapMode="none" truncate>
            <span fg={isStreaming ? cliTheme.accent.primary : marker.color}>
              {`${isStreaming ? spinner : marker.letter} `}
            </span>
            {shownDir ? <span fg={cliTheme.text.muted}>{shownDir}</span> : null}
            <span fg={cliTheme.text.primary} attributes={typeRole("section").attributes}>
              {base}
            </span>
            {agentTouched ? (
              <span fg={cliTheme.accent.primary}>{` ${activeGlyphs.statusDot}`}</span>
            ) : null}
          </text>
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

export function GitBranchHeader({
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
      flexShrink={0}
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
      {/* In list-only (IDE sidebar) mode the surrounding pane already draws the
          card + focus ring, so the list renders frameless to avoid a double border. */}
      <box
        width="100%"
        flexGrow={showDetail ? undefined : 1}
        height={showDetail ? "42%" : undefined}
        flexShrink={listOnly ? 1 : 0}
        flexDirection="column"
        borderStyle={listOnly ? undefined : borderStyleFor.card}
        borderColor={
          listOnly
            ? undefined
            : focused
              ? cliTheme.borders.active
              : cliTheme.borders.default
        }
        backgroundColor={listOnly ? undefined : cliTheme.surfaces.inset}
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
            contentOptions={{ width: "100%", flexDirection: "column" }}
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
            flexShrink={0}
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
