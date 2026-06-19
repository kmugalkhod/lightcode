import type { ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { ChatMessageErrorPart } from "./chat-message-error-part";
import { cliTheme, space } from "../../ui/cli-theme";

interface ChatShellProps {
  title?: string;
  children?: ReactNode;
  hasMessages: boolean;
  messageCount?: number;
  emptyStateLabel?: string;
  errorMessage?: string | null;
  inputArea: ReactNode;
}

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
        <text fg={cliTheme.text.secondary} attributes={TextAttributes.BOLD}>
          {title}
        </text>
        <text fg={cliTheme.text.muted}>{statusLabel}</text>
      </box>
      <box
        width="100%"
        flexGrow={1}
        borderStyle="single"
        borderColor={cliTheme.borders.default}
        backgroundColor={cliTheme.surfaces.inset}
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
            gap: space.md,
          }}
          scrollbarOptions={{
            trackOptions: {
              foregroundColor: cliTheme.scroll.thumb,
              backgroundColor: cliTheme.scroll.rail,
            },
          }}
          verticalScrollbarOptions={{
            trackOptions: {
              foregroundColor: cliTheme.scroll.thumbActive,
              backgroundColor: cliTheme.scroll.rail,
            },
          }}
        >
          {hasMessages ? (
            children
          ) : (
            <box
              width="100%"
              height="100%"
              flexDirection="column"
              alignItems="center"
              justifyContent="center"
              gap={space.xs}
            >
              <text fg={cliTheme.accent.primary} attributes={TextAttributes.BOLD}>
                ◆ ready
              </text>
              <text fg={cliTheme.text.secondary}>{emptyStateLabel}</text>
              <text fg={cliTheme.text.muted}>
                Type a message · / for commands · @ to attach files
              </text>
            </box>
          )}
        </scrollbox>
      </box>
      {errorMessage ? <ChatMessageErrorPart label="Chat error" text={errorMessage} /> : null}
      {inputArea}
    </box>
  );
}
