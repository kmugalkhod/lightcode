import { isToolUIPart, type UIMessage } from "ai";
import { TextAttributes } from "@opentui/core";
import { ChatMessageErrorPart } from "./chat-message-error-part";
import { ChatMessageReasoningPart } from "./chat-message-reasoning-part";
import { ChatMessageTextPart } from "./chat-message-text-part";
import { ChatMessageToolInvocationPart } from "./chat-message-tool-invocation-part";
import { getMessageRoleTheme, space } from "../../ui/cli-theme";
import { activeGlyphs } from "../../ui/cli-theme-capabilities";

interface ChatMessageProps {
  message: UIMessage;
  pendingApprovalIds?: ReadonlySet<string>;
}

const ROLE_LABELS = {
  user: "you",
  assistant: "assistant",
  system: "system",
} satisfies Record<UIMessage["role"], string>;

const ROLE_GLYPHS = {
  user: activeGlyphs.roleUser,
  assistant: activeGlyphs.roleAssistant,
  system: activeGlyphs.roleSystem,
} satisfies Record<UIMessage["role"], string>;

export function ChatMessage({ message, pendingApprovalIds }: ChatMessageProps) {
  const roleStyle = getMessageRoleTheme(message.role);
  const renderedParts = message.parts
    .map((part, index) => {
      const key = `${message.id}:${part.type}:${index}`;

      if (part.type === "text") {
        return <ChatMessageTextPart key={key} part={part} />;
      }

      if (part.type === "reasoning") {
        return <ChatMessageReasoningPart key={key} part={part} />;
      }

      if (isToolUIPart(part)) {
        return (
          <ChatMessageToolInvocationPart
            key={key}
            part={part}
            pendingApprovalIds={pendingApprovalIds}
          />
        );
      }

      if (part.type === "step-start") {
        return null;
      }

      return (
        <ChatMessageErrorPart
          key={key}
          label="Unsupported part"
          text={`Cannot render part type "${part.type}".`}
        />
      );
    })
    .filter((part): part is NonNullable<typeof part> => part !== null);

  if (renderedParts.length === 0) {
    return null;
  }

  // Sleek-minimal turn: no box or background — a role glyph + label header, with
  // the message body indented beneath it. Hierarchy comes from the role color,
  // bold label, and indentation rather than a border around every message.
  return (
    <box width="100%" flexDirection="column" gap={space.xs}>
      <text fg={roleStyle.labelColor} attributes={TextAttributes.BOLD}>
        {`${ROLE_GLYPHS[message.role]} ${ROLE_LABELS[message.role]}`}
      </text>
      <box
        width="100%"
        flexDirection="column"
        gap={space.xs}
        paddingLeft={space.md}
      >
        {renderedParts}
      </box>
    </box>
  );
}
