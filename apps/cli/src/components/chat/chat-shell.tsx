import type { ReactNode } from "react";
import { ChatMessageErrorPart } from "./chat-message-error-part";

interface ChatShellProps {
  title?: string;
  children?: ReactNode;
  hasMessages: boolean;
  isLoading?: boolean;
  loadingLabel?: string;
  emptyStateLabel?: string;
  errorMessage?: string | null;
  inputArea: ReactNode;
}

export function ChatShell({
  title = "Conversation",
  children,
  hasMessages,
  isLoading = false,
  loadingLabel = "Thinking...",
  emptyStateLabel = "No messages yet.",
  errorMessage,
  inputArea,
}: ChatShellProps) {
  return (
    <box width="100%" height="100%" flexDirection="column" gap={1}>
      <text fg="#8A8A8A">{title}</text>
      <box
        flexGrow={1}
        flexDirection="column"
        gap={1}
        borderStyle="single"
        borderColor="#303030"
        paddingX={1}
        paddingY={1}
      >
        {hasMessages ? children : <text fg="#8A8A8A">{emptyStateLabel}</text>}
        {isLoading ? <text fg="#8A8A8A">{loadingLabel}</text> : null}
      </box>
      {errorMessage ? <ChatMessageErrorPart label="Chat error" text={errorMessage} /> : null}
      {inputArea}
    </box>
  );
}
