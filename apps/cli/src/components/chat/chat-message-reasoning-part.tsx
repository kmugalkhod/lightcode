import type { ReasoningUIPart } from "ai";

interface ChatMessageReasoningPartProps {
  part: ReasoningUIPart;
}

export function ChatMessageReasoningPart({ part }: ChatMessageReasoningPartProps) {
  if (!part.text) {
    return null;
  }

  return (
    <box flexDirection="column">
      <text fg="#8A8A8A">Reasoning</text>
      <text fg="#9CA3AF">{part.text}</text>
    </box>
  );
}
