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

function formatPartValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  try {
    const jsonValue = JSON.stringify(value);

    if (!jsonValue) {
      return String(value);
    }

    return jsonValue.length > 200 ? `${jsonValue.slice(0, 197)}...` : jsonValue;
  } catch {
    return String(value);
  }
}

const TOOL_STATE_LABELS = {
  "input-streaming": "collecting input",
  "input-available": "running",
  "approval-requested": "awaiting approval",
  "approval-responded": "approval received",
  "output-available": "completed",
  "output-error": "failed",
  "output-denied": "denied",
} satisfies Record<ToolPartState, string>;

export function ChatMessageToolInvocationPart({
  part,
}: ChatMessageToolInvocationPartProps) {
  const toolName = getToolName(part);

  return (
    <box flexDirection="column">
      <text fg="#8A8A8A">
        Tool {toolName}: {TOOL_STATE_LABELS[part.state]}
      </text>
      {part.input !== undefined ? (
        <text fg="#B3B3B3">input: {formatPartValue(part.input)}</text>
      ) : null}
      {part.state === "output-available" ? (
        <text fg="#D1D5DB">output: {formatPartValue(part.output)}</text>
      ) : null}
      {part.state === "output-denied" && part.approval.reason ? (
        <text fg="#FBBF24">reason: {part.approval.reason}</text>
      ) : null}
    </box>
  );
}
