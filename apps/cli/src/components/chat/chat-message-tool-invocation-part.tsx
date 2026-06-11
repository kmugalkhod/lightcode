import { TextAttributes } from "@opentui/core";
import {
  getToolName,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UITools,
} from "ai";
import { useAppState } from "../../state/app-state";
import { cliTheme, getToolToneColor, type ToolInvocationState } from "../../ui/cli-theme";
import { truncateInline } from "../../utils/text-utils";
import { ChatDiffCard } from "./chat-diff-card";

const COLLAPSED_OUTPUT_LINES = 3;
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

type AnyToolPart = ToolUIPart<UITools> | DynamicToolUIPart;

interface ChatMessageToolInvocationPartProps {
  part: AnyToolPart;
  pendingApprovalIds?: ReadonlySet<string>;
}

const TOOL_STATE_VIEW = {
  "input-streaming": { symbol: ">", verb: "Preparing" },
  "input-available": { symbol: ">", verb: "Running" },
  "approval-requested": { symbol: "!", verb: "Approval needed for" },
  "approval-responded": { symbol: ">", verb: "Approval received for" },
  "output-available": { symbol: "OK", verb: "Completed" },
  "output-error": { symbol: "ERR", verb: "Failed" },
  "output-denied": { symbol: "NO", verb: "Denied" },
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

function getFileEditDiff(part: AnyToolPart): { path: string; diff: string } | null {
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

  const matches = Reflect.get(output, "matches");
  if (Array.isArray(matches)) {
    return [`${matches.length} match${matches.length === 1 ? "" : "es"}`];
  }

  return [];
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
    ? { symbol: "!", verb: "Approval pending for" }
    : TOOL_STATE_VIEW[part.state];
  const stateColor = isPendingApproval
    ? cliTheme.semantic.warning
    : getToolToneColor(part.state);
  const line = `${stateView.symbol} ${stateView.verb} [${humanizeToolName(toolName)}] ${target ?? ""}`.trimEnd();
  const fileEditDiff = getFileEditDiff(part);
  const secondaryParams = getSecondaryParams(part.input, target);
  const outputPreviewLines = fileEditDiff
    ? []
    : getOutputPreviewLines(
        part,
        expandedToolOutput ? EXPANDED_OUTPUT_LINES : COLLAPSED_OUTPUT_LINES,
      );

  return (
    <box flexDirection="column">
      <text fg={stateColor}>
        {line}
      </text>
      {secondaryParams ? (
        <text fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
          {`  ${secondaryParams}`}
        </text>
      ) : null}
      {part.state === "output-error" ? <text fg={cliTheme.text.secondary}>{part.errorText}</text> : null}
      {part.state === "output-denied" && part.approval.reason ? (
        <text fg={cliTheme.semantic.warning}>Reason: {part.approval.reason}</text>
      ) : null}
      {outputPreviewLines.length > 0 ? (
        <box
          flexDirection="column"
          paddingX={1}
          backgroundColor={cliTheme.surfaces.inset}
        >
          {outputPreviewLines.map((previewLine, index) => (
            <text
              key={`${part.toolCallId}-preview-${index}`}
              fg={cliTheme.text.muted}
            >
              {previewLine || " "}
            </text>
          ))}
          {!expandedToolOutput ? (
            <text fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
              Ctrl+O expand
            </text>
          ) : null}
        </box>
      ) : null}
      {fileEditDiff ? (
        <ChatDiffCard path={fileEditDiff.path} diff={fileEditDiff.diff} />
      ) : null}
    </box>
  );
}
