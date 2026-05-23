import type { ReactNode } from "react";
import { ChatMessageErrorPart } from "./chat-message-error-part";

interface ChatShellProps {
  title?: string;
  children?: ReactNode;
  hasMessages: boolean;
  messageCount?: number;
  emptyStateLabel?: string;
  errorMessage?: string | null;
  inputArea: ReactNode;
}

const chatScrollbarTheme = {
  rail: "#0B0F16",
  thumb: "#1E3A5F",
  thumbActive: "#22D3EE",
};

export function ChatShell({
  title = "Conversation",
  children,
  hasMessages,
  messageCount = 0,
  emptyStateLabel = "Send a prompt to start chatting.",
  errorMessage,
  inputArea,
}: ChatShellProps) {
  const statusLabel = `${messageCount} message${messageCount === 1 ? "" : "s"}`;

  return (
    <box width="100%" height="100%" flexDirection="column" gap={1}>
      <box width="100%" flexDirection="row" justifyContent="space-between" paddingX={1}>
        <text fg="#A3A3A3">{title}</text>
        <text fg="#6B7280">{statusLabel}</text>
      </box>
      <box
        width="100%"
        flexGrow={1}
        borderStyle="single"
        borderColor="#223142"
        backgroundColor="#06080D"
      >
        <scrollbox
          width="100%"
          height="100%"
          flexGrow={1}
          paddingX={1}
          paddingY={1}
          scrollY
          stickyScroll
          stickyStart="bottom"
          contentOptions={{
            width: "100%",
            flexDirection: "column",
            gap: 1,
          }}
          scrollbarOptions={{
            trackOptions: {
              foregroundColor: chatScrollbarTheme.thumb,
              backgroundColor: chatScrollbarTheme.rail,
            },
          }}
          verticalScrollbarOptions={{
            trackOptions: {
              foregroundColor: chatScrollbarTheme.thumbActive,
              backgroundColor: chatScrollbarTheme.rail,
            },
          }}
        >
          {hasMessages ? children : <text fg="#8A8A8A">{emptyStateLabel}</text>}
        </scrollbox>
      </box>
      {errorMessage ? <ChatMessageErrorPart label="Chat error" text={errorMessage} /> : null}
      {inputArea}
    </box>
  );
}
