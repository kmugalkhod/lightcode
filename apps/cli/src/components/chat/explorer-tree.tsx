import { useState } from "react";
import { borderStyleFor, cliTheme, typeRole } from "../../ui/cli-theme";
import { activeGlyphs } from "../../ui/cli-theme-capabilities";
import { fileTypeStyle } from "../../ui/file-type-style";
import type { FileTreeApi, FileTreeNode } from "./use-file-tree";
import type { ChangedFileChangeKind } from "./use-changed-files";
import { ELLIPSIS, CARET_OPEN, CARET_CLOSED, INDENT_GUIDE, FILE_GLYPH, changeMarker, PanePlaceholder } from "./explorer-shared";

export function TreeRow({
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
      {/* One text run (guides + caret + name): truncation keeps the leading
          glyphs and clips the tail, so long names can't tear the tree apart. */}
      <box flexDirection="row" alignItems="center" flexGrow={1} flexShrink={1}>
        <text wrapMode="none" truncate>
          {Array.from({ length: node.depth }, (_, level) => (
            <span key={level} fg={cliTheme.borders.subtle}>{`${INDENT_GUIDE} `}</span>
          ))}
          <span fg={leadColor}>{`${caret} `}</span>
          <span
            fg={node.isDir ? cliTheme.accent.softText : cliTheme.text.primary}
            attributes={node.isDir ? typeRole("section").attributes : undefined}
          >
            {node.isDir ? `${node.name}/` : node.name}
          </span>
        </text>
      </box>
      {marker ? <text fg={marker.color}>{marker.letter}</text> : null}
    </box>
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
        flexShrink={0}
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
