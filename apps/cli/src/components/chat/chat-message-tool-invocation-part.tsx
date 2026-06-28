import { typeRole } from "../../ui/cli-theme";
import {
  getToolName,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UITools,
} from "ai";
import { useAppState } from "../../state/app-state";
import { cliTheme, getToolToneColor, borderStyleFor, type ToolInvocationState } from "../../ui/cli-theme";
import { activeGlyphs } from "../../ui/cli-theme-capabilities";
import { truncateInline } from "../../utils/text-utils";
import { ChatDiffCard } from "./chat-diff-card";

const EXPANDED_OUTPUT_LINES = 18;
const OUTPUT_LINE_MAX_CHARS = 160;

/** Output fields worth previewing, in priority order. */
const previewOutputKeys = [
  "stdout",
  "stderr",
  "content",
  "text",
  "summary",
  "message",
] as const;

export type AnyToolPart = ToolUIPart<UITools> | DynamicToolUIPart;

interface ChatMessageToolInvocationPartProps {
  part: AnyToolPart;
  pendingApprovalIds?: ReadonlySet<string>;
}

const TOOL_STATE_VIEW = {
  "input-streaming": { symbol: activeGlyphs.toolRunning, verb: "Preparing" },
  "input-available": { symbol: activeGlyphs.toolRunning, verb: "Running" },
  "approval-requested": { symbol: activeGlyphs.toolApproval, verb: "Approval needed for" },
  "approval-responded": { symbol: activeGlyphs.toolRunning, verb: "Approval received for" },
  "output-available": { symbol: activeGlyphs.toolOk, verb: "Completed" },
  "output-error": { symbol: activeGlyphs.toolError, verb: "Failed" },
  "output-denied": { symbol: activeGlyphs.toolDenied, verb: "Denied" },
} satisfies Record<ToolInvocationState, { symbol: string; verb: string }>;

function humanizeToolName(toolName: string) {
  return toolName.replaceAll("_", " ");
}

function getToolTarget(input: unknown) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const candidates = [
    Reflect.get(input, "path"),
    Reflect.get(input, "command"),
    Reflect.get(input, "query"),
    Reflect.get(input, "pattern"),
    Reflect.get(input, "revision"),
    Reflect.get(input, "url"),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function normalizeToolTarget(target: string | null) {
  if (!target) {
    return null;
  }

  if (target === "." || target === "./" || target === ".\\") {
    return "workspace root";
  }

  return target;
}

export function getFileEditDiff(part: AnyToolPart): { path: string; diff: string } | null {
  if (part.state !== "output-available") {
    return null;
  }

  const output = part.output;
  if (!output || typeof output !== "object") {
    return null;
  }

  const diff = Reflect.get(output, "diff");
  const path = Reflect.get(output, "path");
  if (typeof diff !== "string" || !diff.trim() || typeof path !== "string") {
    return null;
  }

  return { path, diff };
}

/** Secondary params beyond the headline target, shown as a dim detail line. */
function getSecondaryParams(input: unknown, target: string | null): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const entries = Object.entries(input as Record<string, unknown>)
    .filter(([, value]) => {
      if (typeof value === "string") {
        return value.trim().length > 0 && value !== target;
      }
      return typeof value === "number" || typeof value === "boolean";
    })
    .slice(0, 4)
    .map(([key, value]) =>
      `${key}=${truncateInline(typeof value === "string" ? value : String(value), 40)}`,
    );

  return entries.length > 0 ? entries.join(" ") : null;
}

function getOutputPreviewLines(part: AnyToolPart, maxLines: number): string[] {
  if (part.state !== "output-available") {
    return [];
  }

  const output = part.output;
  if (typeof output === "string") {
    return output
      .split(/\r?\n/)
      .slice(0, maxLines)
      .map((line) => truncateInline(line, OUTPUT_LINE_MAX_CHARS));
  }

  if (!output || typeof output !== "object") {
    return [];
  }

  for (const key of previewOutputKeys) {
    const value = Reflect.get(output, key);
    if (typeof value === "string" && value.trim()) {
      return value
        .split(/\r?\n/)
        .slice(0, maxLines)
        .map((line) => truncateInline(line, OUTPUT_LINE_MAX_CHARS));
    }
  }

  return [];
}

export function countDiffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed++;
    }
  }
  return { added, removed };
}

export function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
}

function summarizeToolOutput(part: AnyToolPart): { text: string; isError?: boolean } | null {
  if (part.state === "output-error") {
    return { text: "Failed to execute tool", isError: true };
  }

  if (part.state === "output-denied") {
    return { text: "Execution denied", isError: true };
  }

  if (part.state !== "output-available") {
    return null;
  }

  const output = part.output;
  if (typeof output === "string") {
    const lines = output.trim().split(/\r?\n/);
    if (lines.length === 0 || !lines[0]) {
      return { text: "No output generated" };
    }
    if (lines.length === 1) {
      return null; // A single line of output will be shown in the preview directly.
    }
    return { text: `${lines.length} lines of output` };
  }

  if (!output || typeof output !== "object") {
    return { text: "Completed" };
  }

  const keys = Object.keys(output).filter((k) => k !== "error");
  const hasError = Boolean(Reflect.get(output, "error"));

  if (keys.includes("matches") && Reflect.get(output, "matches") instanceof Array) {
    const count = (Reflect.get(output, "matches") as unknown[]).length;
    return { text: `Found ${count} match${count === 1 ? "" : "es"}`, isError: hasError };
  }

  if (keys.includes("entries") && Reflect.get(output, "entries") instanceof Array) {
    const count = (Reflect.get(output, "entries") as unknown[]).length;
    return { text: `Listed ${count} file${count === 1 ? "" : "s"}`, isError: hasError };
  }

  return { text: "Completed", isError: hasError };
}

export function ChatMessageToolInvocationPart({
  part,
  pendingApprovalIds,
}: ChatMessageToolInvocationPartProps) {
  const { expandedToolOutput } = useAppState();
  const toolName = getToolName(part);
  const target = normalizeToolTarget(getToolTarget(part.input));
  const label = target ?? humanizeToolName(toolName);
  const isPendingApproval =
    part.state === "input-available" && pendingApprovalIds?.has(part.toolCallId);
  const stateView = isPendingApproval
    ? { symbol: activeGlyphs.toolApproval, verb: "Approval pending for" }
    : TOOL_STATE_VIEW[part.state];
  const stateColor = isPendingApproval
    ? cliTheme.semantic.warning
    : getToolToneColor(part.state);
  const line = `${stateView.symbol} ${stateView.verb} [${humanizeToolName(toolName)}] ${target ?? ""}`.trimEnd();
  const fileEditDiff = getFileEditDiff(part);
  const secondaryParams = getSecondaryParams(part.input, target);

  // Edited files get a "+A -R" summary above the (already collapsible) diff card.
  const editSummary = fileEditDiff
    ? (() => {
        const { added, removed } = countDiffStats(fileEditDiff.diff);
        return `Edited ${basename(fileEditDiff.path)} (+${added} -${removed})`;
      })()
    : null;

  const resultSummary = fileEditDiff ? null : summarizeToolOutput(part);

  // Raw output lives behind Ctrl+O. The summary line is the default view.
  const rawPreviewLines =
    !fileEditDiff && expandedToolOutput
      ? getOutputPreviewLines(part, EXPANDED_OUTPUT_LINES)
      : [];
  const hasCollapsedRawOutput =
    !fileEditDiff &&
    !expandedToolOutput &&
    getOutputPreviewLines(part, 1).length > 0;

  return (
    <box 
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      paddingBottom={1}
      paddingTop={1}
      borderStyle={borderStyleFor.chrome}
      border={["left"]}
      borderColor={stateColor}
      backgroundColor={cliTheme.surfaces.inset}
      gap={fileEditDiff || rawPreviewLines.length > 0 ? 1 : 0}
    >
      <text {...typeRole("title")} fg={stateColor}>
        {line}
      </text>
      {secondaryParams ? (
        <text {...typeRole("caption")}>
          {`  ${secondaryParams}`}
        </text>
      ) : null}
      {editSummary ? (
        <text fg={cliTheme.text.muted}>{`  ${activeGlyphs.indent} ${editSummary}`}</text>
      ) : null}
      {resultSummary ? (
        <text
          fg={
            resultSummary.isError
              ? cliTheme.semantic.warning
              : cliTheme.text.muted
          }
        >
          {`  ${activeGlyphs.indent} ${resultSummary.text}`}
          {hasCollapsedRawOutput ? " · Ctrl+O" : ""}
        </text>
        ) : hasCollapsedRawOutput ? (
        <text {...typeRole("caption")}>
          {`  ${activeGlyphs.indent} Ctrl+O to expand`}
        </text>
      ) : null}
      {part.state === "output-error" ? <text fg={cliTheme.text.secondary}>{part.errorText}</text> : null}
      {part.state === "output-denied" && part.approval.reason ? (
        <text fg={cliTheme.semantic.warning}>Reason: {part.approval.reason}</text>
      ) : null}
      {rawPreviewLines.length > 0 ? (
        <box
          flexDirection="column"
          paddingX={1}
          backgroundColor={cliTheme.surfaces.inset}
        >
          {rawPreviewLines.map((previewLine, index) => (
            <text
              key={`${part.toolCallId}-preview-${index}`}
              fg={cliTheme.text.muted}
            >
              {previewLine || " "}
            </text>
          ))}
        </box>
      ) : null}
      {fileEditDiff ? (
        <ChatDiffCard path={fileEditDiff.path} diff={fileEditDiff.diff} />
      ) : null}
    </box>
  );
}
