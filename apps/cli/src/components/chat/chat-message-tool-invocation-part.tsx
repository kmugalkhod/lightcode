import {
  getToolName,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UITools,
} from "ai";

type AnyToolPart = ToolUIPart<UITools> | DynamicToolUIPart;
type ToolPartState = AnyToolPart["state"];

interface ChatMessageToolInvocationPartProps {
  part: AnyToolPart;
}

const TOOL_STATE_VIEW = {
  "input-streaming": { symbol: "\u2192", verb: "Preparing", color: "#8A8A8A" },
  "input-available": { symbol: "\u2192", verb: "Running", color: "#93C5FD" },
  "approval-requested": { symbol: "\u26A0", verb: "Approval needed for", color: "#F59E0B" },
  "approval-responded": { symbol: "\u2192", verb: "Approval received for", color: "#93C5FD" },
  "output-available": { symbol: "\u2713", verb: "Completed", color: "#86EFAC" },
  "output-error": { symbol: "\u2717", verb: "Failed", color: "#F87171" },
  "output-denied": { symbol: "\u2715", verb: "Denied", color: "#FBBF24" },
} satisfies Record<ToolPartState, { symbol: string; verb: string; color: string }>;

function humanizeToolName(toolName: string) {
  return toolName.replaceAll("_", " ");
}

function getToolTarget(input: unknown) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const value = input as Record<string, unknown>;
  const candidates = [value.path, value.command, value.query];

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

export function ChatMessageToolInvocationPart({
  part,
}: ChatMessageToolInvocationPartProps) {
  const toolName = getToolName(part);
  const target = normalizeToolTarget(getToolTarget(part.input));
  const label = target ?? humanizeToolName(toolName);
  const stateView = TOOL_STATE_VIEW[part.state];
  const line = `${stateView.symbol} ${stateView.verb} ${label}`;

  return (
    <box flexDirection="column">
      <text fg={stateView.color}>
        {line}
      </text>
      {part.state === "output-error" ? <text fg="#FCA5A5">{part.errorText}</text> : null}
      {part.state === "output-denied" && part.approval.reason ? (
        <text fg="#FBBF24">Reason: {part.approval.reason}</text>
      ) : null}
    </box>
  );
}
