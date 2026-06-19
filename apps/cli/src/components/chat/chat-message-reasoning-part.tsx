import { TextAttributes } from "@opentui/core";
import type { ReasoningUIPart } from "ai";
import { useAppState } from "../../state/app-state";
import { cliTheme } from "../../ui/cli-theme";

interface ChatMessageReasoningPartProps {
  part: ReasoningUIPart;
}

export function ChatMessageReasoningPart({ part }: ChatMessageReasoningPartProps) {
  const { expandedReasoning } = useAppState();

  if (!part.text) {
    return null;
  }

  // Hidden by default — reasoning is rarely what the user wants to read. A dim
  // one-liner advertises the Ctrl+R toggle without crowding the transcript.
  if (!expandedReasoning) {
    return (
      <box paddingX={1}>
        <text fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
          Thinking… (Ctrl+R to view)
        </text>
      </box>
    );
  }

  return (
    <box flexDirection="column" gap={1}>
      <text fg={cliTheme.semantic.info}>Thinking:</text>
      <text fg={cliTheme.text.secondary}>{part.text}</text>
    </box>
  );
}
