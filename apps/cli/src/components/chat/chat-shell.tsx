import type { ReactNode } from "react";
import { typeRole } from "../../ui/cli-theme";
import { ChatMessageErrorPart } from "./chat-message-error-part";
import { cliTheme, space, borderStyleFor } from "../../ui/cli-theme";

interface ChatShellProps {
  title?: string;
  /** Muted context after the title, e.g. project folder and git branch. */
  context?: readonly string[];
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
  title = "New session",
  context = [],
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
    // No gaps between header, transcript and input: the transcript border
    // already separates them, and every row goes to the conversation.
    <box width="100%" height="100%" flexDirection="column">
      <box width="100%" height={1} flexDirection="row" justifyContent="space-between" alignItems="center" paddingX={1} flexShrink={0} gap={2}>
        <box flexDirection="row" flexShrink={1} overflow="hidden" height={1}>
          <text wrapMode="none" truncate>
            <span {...typeRole("title")}>{title}</span>
            {context.length > 0 ? (
              <span fg={cliTheme.text.muted}>{` · ${context.join(" · ")}`}</span>
            ) : null}
          </text>
        </box>
        <box flexDirection="row" alignItems="center" gap={2} flexShrink={0}>
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
