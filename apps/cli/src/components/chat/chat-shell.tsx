import type { ReactNode } from "react";
import { typeRole } from "../../ui/cli-theme";
import { ChatMessageErrorPart } from "./chat-message-error-part";
import { cliTheme, space, borderStyleFor } from "../../ui/cli-theme";

interface ChatShellProps {
  title?: string;
  children?: ReactNode;
  hasMessages: boolean;
  messageCount?: number;
  emptyStateLabel?: string;
  errorMessage?: string | null;
  inputArea: ReactNode;
  /** Optional control rendered at the top-right of the header (e.g. panel toggle). */
  headerRight?: ReactNode;
  /** Active-pane focus ring (IDE layout): amber border when this pane has focus. */
  focused?: boolean;
}

export function ChatShell({
  title = "Conversation",
  children,
  hasMessages,
  messageCount = 0,
  emptyStateLabel = "Send a prompt to start chatting.",
  errorMessage,
  inputArea,
  headerRight,
  focused = false,
}: ChatShellProps) {
  const statusLabel = `${messageCount} message${messageCount === 1 ? "" : "s"}`;

  return (
    <box width="100%" height="100%" flexDirection="column" gap={1}>
      <box width="100%" flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={1}>
        <text {...typeRole("title")}>{title}</text>
        <box flexDirection="row" alignItems="center" gap={2}>
          <text fg={cliTheme.text.muted}>{statusLabel}</text>
          {headerRight}
        </box>
      </box>
      <box
        width="100%"
        flexGrow={1}
        borderStyle={borderStyleFor.card}
        borderColor={focused ? cliTheme.borders.active : cliTheme.borders.default}
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
              <text {...typeRole("emphasis")}>◆ ready</text>
              <text {...typeRole("secondary")}>{emptyStateLabel}</text>
              <text {...typeRole("caption")}>
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
