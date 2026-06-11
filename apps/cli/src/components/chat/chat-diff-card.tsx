import { TextAttributes } from "@opentui/core";
import { cliTheme } from "../../ui/cli-theme";
import { codeSyntaxStyle, inferFiletype } from "../../ui/code-syntax-style";

const COLLAPSED_MAX_LINES = 20;
const TRUNCATION_MARKER = "... diff truncated ...";

const addedBg = "#13271B";
const removedBg = "#2B1619";

interface ChatDiffCardProps {
  path: string;
  diff: string;
}

/**
 * Cuts the diff at a hunk boundary so the collapsed view still parses as a
 * valid unified diff. A single oversized hunk is shown in full.
 */
function collapseDiff(diff: string): { text: string; hiddenLines: number } {
  const lines = diff.split("\n");
  if (lines.length <= COLLAPSED_MAX_LINES) {
    return { text: diff, hiddenLines: 0 };
  }

  const hunkStarts = lines
    .map((line, index) => (line.startsWith("@@") ? index : -1))
    .filter((index) => index > 0);
  const cutCandidates = hunkStarts.filter(
    (index) => index <= COLLAPSED_MAX_LINES,
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

export function ChatDiffCard({ path, diff }: ChatDiffCardProps) {
  const wasPreTruncated = diff.trimEnd().endsWith(TRUNCATION_MARKER);
  const cleanDiff = wasPreTruncated
    ? diff.trimEnd().slice(0, -TRUNCATION_MARKER.length).trimEnd()
    : diff;
  const { text, hiddenLines } = collapseDiff(cleanDiff);

  if (!text.trim()) {
    return null;
  }

  return (
    <box
      width="100%"
      flexDirection="column"
      borderStyle="single"
      borderColor={cliTheme.borders.subtle}
      backgroundColor={cliTheme.surfaces.inset}
    >
      <box paddingX={1}>
        <text fg={cliTheme.text.secondary} attributes={TextAttributes.BOLD}>
          {path}
        </text>
      </box>
      <diff
        width="100%"
        diff={text}
        view="unified"
        filetype={inferFiletype(path)}
        syntaxStyle={codeSyntaxStyle}
        showLineNumbers
        addedBg={addedBg}
        removedBg={removedBg}
        lineNumberFg={cliTheme.text.muted}
        lineNumberBg={cliTheme.surfaces.inset}
        addedSignColor={cliTheme.semantic.success}
        removedSignColor={cliTheme.semantic.error}
      />
      {hiddenLines > 0 || wasPreTruncated ? (
        <box paddingX={1}>
          <text fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
            {hiddenLines > 0 ? `+${hiddenLines} more diff lines` : "diff truncated"}
          </text>
        </box>
      ) : null}
    </box>
  );
}
