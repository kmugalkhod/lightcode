import type { ToolView } from "./tool-view";

const maximumDiffLines = 400;
const maximumOutputChars = 6_000;

function clip(text: string, limit = maximumOutputChars): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
}

export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  const shown = lines.slice(0, maximumDiffLines);
  return (
    <pre className="diff-view" aria-label="Changes">
      {shown.map((line, index) => {
        const tone =
          line.startsWith("+++") || line.startsWith("---")
            ? "meta"
            : line.startsWith("@@")
              ? "hunk"
              : line.startsWith("+")
                ? "added"
                : line.startsWith("-")
                  ? "removed"
                  : "context";
        return (
          <span key={index} className={`diff-line ${tone}`}>
            {line || " "}
            {"\n"}
          </span>
        );
      })}
      {lines.length > shown.length ? (
        <span className="diff-line meta">{`… ${lines.length - shown.length} more lines`}</span>
      ) : null}
    </pre>
  );
}

/** The readable part of a finished tool call; raw JSON lives in "Details". */
export function ToolViewBody({ view }: { view: ToolView }) {
  if (view.kind === "diff") {
    return (
      <div className="tool-view">
        <span className="tool-view-path">{view.path}</span>
        <DiffView diff={view.diff} />
      </div>
    );
  }
  if (view.kind === "command") {
    const output = [view.stdout, view.stderr].filter((text) => text.trim()).join("\n");
    return (
      <div className="tool-view">
        <pre className="command-line">
          <span aria-hidden="true">$ </span>
          {view.command}
        </pre>
        {output ? (
          <pre className={view.exitCode === 0 ? "command-output" : "command-output failed"}>
            {clip(output)}
            {view.truncated ? "\n[output truncated]" : ""}
          </pre>
        ) : (
          <span className="tool-view-note">No output</span>
        )}
      </div>
    );
  }
  if (view.kind === "matches") {
    return view.items.length > 0 ? (
      <ul className="tool-view-list">
        {view.items.map((item, index) => (
          <li key={`${item}-${index}`}>{item}</li>
        ))}
        {view.total > view.items.length ? (
          <li className="tool-view-note">{`… ${view.total - view.items.length} more`}</li>
        ) : null}
      </ul>
    ) : (
      <span className="tool-view-note">No results</span>
    );
  }
  if (view.kind === "read") {
    return <span className="tool-view-path">{view.path}</span>;
  }
  return null;
}
