import { TextAttributes } from "@opentui/core";
import { collectMessageText } from "@lightcode/ai";
import type { UIMessage } from "ai";
import { cliTheme, getOverlayRowColors } from "../../ui/cli-theme";
import { truncateInline } from "../../utils/text-utils";

interface CopyModeOverlayProps {
  /** Copyable messages, oldest first (same order as the transcript). */
  messages: UIMessage[];
  selectedIndex: number;
}

/** How many rows to show around the selection at once. */
const WINDOW_SIZE = 7;

function previewOf(message: UIMessage): string {
  const text = collectMessageText(message).replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : "(no text)";
}

export function CopyModeOverlay({ messages, selectedIndex }: CopyModeOverlayProps) {
  const total = messages.length;
  const half = Math.floor(WINDOW_SIZE / 2);
  const end = Math.min(total, Math.max(selectedIndex + half + 1, WINDOW_SIZE));
  const start = Math.max(0, end - WINDOW_SIZE);
  const visible = messages.slice(start, end);

  return (
    <box
      flexDirection="column"
      paddingX={1}
      paddingY={1}
      borderStyle="single"
      borderColor={cliTheme.accent.primary}
    >
      <text fg={cliTheme.accent.primary} attributes={TextAttributes.BOLD}>
        Copy mode — ↑/↓ select · Enter copy · c code blocks · Esc exit
      </text>
      {visible.map((message, offset) => {
        const index = start + offset;
        const isSelected = index === selectedIndex;
        const rowColors = getOverlayRowColors(isSelected);
        const role = message.role === "user" ? "You" : "Assistant";

        return (
          <box
            key={message.id}
            paddingX={1}
            backgroundColor={rowColors.backgroundColor}
          >
            <text fg={rowColors.primaryTextColor}>
              {`${role}: ${truncateInline(previewOf(message), 80)}`}
            </text>
          </box>
        );
      })}
      {total > visible.length ? (
        <text fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
          {`${selectedIndex + 1}/${total}`}
        </text>
      ) : null}
    </box>
  );
}
