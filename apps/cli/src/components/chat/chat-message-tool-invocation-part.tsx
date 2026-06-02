import {
  getToolName,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UITools,
} from "ai";
import { cliTheme, getToolToneColor, type ToolInvocationState } from "../../ui/cli-theme";

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

export function ChatMessageToolInvocationPart({
  part,
  pendingApprovalIds,
}: ChatMessageToolInvocationPartProps) {
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
  const line = `${stateView.symbol} ${stateView.verb} ${label}`;

  return (
    <box flexDirection="column">
      <text fg={stateColor}>
        {line}
      </text>
      {part.state === "output-error" ? <text fg={cliTheme.text.secondary}>{part.errorText}</text> : null}
      {part.state === "output-denied" && part.approval.reason ? (
        <text fg={cliTheme.semantic.warning}>Reason: {part.approval.reason}</text>
      ) : null}
    </box>
  );
}
