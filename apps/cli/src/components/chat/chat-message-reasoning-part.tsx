import type { ReasoningUIPart } from "ai";
import { cliTheme } from "../../ui/cli-theme";

interface ChatMessageReasoningPartProps {
  part: ReasoningUIPart;
}

export function ChatMessageReasoningPart({ part }: ChatMessageReasoningPartProps) {
  if (!part.text) {
    return null;
  }

  return (
    <box flexDirection="column" gap={1}>
      <text fg={cliTheme.semantic.info}>Thinking:</text>
      <text fg={cliTheme.text.secondary}>{part.text}</text>
    </box>
  );
}
