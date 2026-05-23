import type { ReasoningUIPart } from "ai";

interface ChatMessageReasoningPartProps {
  part: ReasoningUIPart;
}

export function ChatMessageReasoningPart({ part }: ChatMessageReasoningPartProps) {
  if (!part.text) {
    return null;
  }

  return (
    <box flexDirection="column" gap={1}>
      <text fg="#A78BFA">Thinking:</text>
      <text fg="#94A3B8">{part.text}</text>
    </box>
  );
}
