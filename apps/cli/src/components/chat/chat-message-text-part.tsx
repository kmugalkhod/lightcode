import type { TextUIPart } from "ai";

interface ChatMessageTextPartProps {
  part: TextUIPart;
}

export function ChatMessageTextPart({ part }: ChatMessageTextPartProps) {
  if (!part.text) {
    return null;
  }

  return <text>{part.text}</text>;
}
