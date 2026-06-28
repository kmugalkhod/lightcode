import { borderStyleFor, cliTheme, typeRole } from "../../ui/cli-theme";
import { codeSyntaxStyle, inferFiletype } from "../../ui/code-syntax-style";

const COLLAPSED_MAX_LINES = 20;
const TRUNCATION_MARKER = "... diff truncated ...";

interface ChatDiffCardProps {
  path: string;
  diff: string;
  /**
   * Max lines before the diff is cut at a hunk boundary with a "+N more"
   * footer. Defaults to the compact inline cap; the Changes panel passes a
   * larger value so the full diff reads as a "deep look".
   */
  maxLines?: number;
  /** Hide the path header (the panel renders its own selected-file header). */
  hideHeader?: boolean;
  /**
   * Drop the card's own border/background so it can sit inside another framed
   * container (the Changes panel) without a double border.
   */
  bare?: boolean;
  /**
   * Diff layout: "unified" (default, single column) or "split" (side-by-side).
   * Split needs a wide container; the full-width center editor pane passes it.
   */
  view?: "unified" | "split";
}

/**
 * Cuts the diff at a hunk boundary so the collapsed view still parses as a
 * valid unified diff. A single oversized hunk is shown in full.
 */
function collapseDiff(
  diff: string,
  maxLines: number,
): { text: string; hiddenLines: number } {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) {
    return { text: diff, hiddenLines: 0 };
  }

  const hunkStarts = lines
    .map((line, index) => (line.startsWith("@@") ? index : -1))
    .filter((index) => index > 0);
  const cutCandidates = hunkStarts.filter(
    (index) => index <= maxLines,
  );
  // Skip the first hunk header — cutting there would show an empty diff.
  const cut = cutCandidates.length > 1 ? cutCandidates[cutCandidates.length - 1] : null;

  if (cut === null) {
    return { text: diff, hiddenLines: 0 };
  }

  return {
    text: lines.slice(0, cut).join("\n"),
    hiddenLines: lines.length - cut,
  };
}

export function ChatDiffCard({
  path,
  diff,
  maxLines = COLLAPSED_MAX_LINES,
  hideHeader = false,
  bare = false,
  view = "unified",
}: ChatDiffCardProps) {
  const wasPreTruncated = diff.trimEnd().endsWith(TRUNCATION_MARKER);
  const cleanDiff = wasPreTruncated
    ? diff.trimEnd().slice(0, -TRUNCATION_MARKER.length).trimEnd()
    : diff;
  const { text, hiddenLines } = collapseDiff(cleanDiff, maxLines);

  if (!text.trim()) {
    return null;
  }

  return (
    <box
      width="100%"
      flexDirection="column"
      borderStyle={bare ? undefined : borderStyleFor.card}
      borderColor={bare ? undefined : cliTheme.borders.subtle}
      backgroundColor={bare ? undefined : cliTheme.surfaces.inset}
    >
      {hideHeader ? null : (
        <box paddingX={1}>
          <text {...typeRole("section")}>{path}</text>
        </box>
      )}
      <diff
        width="100%"
        diff={text}
        view={view}
        filetype={inferFiletype(path)}
        syntaxStyle={codeSyntaxStyle}
        showLineNumbers
        addedBg={cliTheme.diff.addedBg}
        removedBg={cliTheme.diff.removedBg}
        lineNumberFg={cliTheme.text.muted}
        lineNumberBg={cliTheme.surfaces.inset}
        addedSignColor={cliTheme.diff.added}
        removedSignColor={cliTheme.diff.removed}
      />
      {hiddenLines > 0 || wasPreTruncated ? (
        <box paddingX={1}>
          <text {...typeRole("caption")}>
            {hiddenLines > 0 ? `+${hiddenLines} more diff lines` : "diff truncated"}
          </text>
        </box>
      ) : null}
    </box>
  );
}
