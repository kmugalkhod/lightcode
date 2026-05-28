import { isToolUIPart, type UIMessage } from "ai";
import { ChatMessageErrorPart } from "./chat-message-error-part";
import { ChatMessageReasoningPart } from "./chat-message-reasoning-part";
import { ChatMessageTextPart } from "./chat-message-text-part";
import { ChatMessageToolInvocationPart } from "./chat-message-tool-invocation-part";
import { getMessageRoleTheme } from "../../ui/cli-theme";

interface ChatMessageProps {
  message: UIMessage;
  pendingApprovalIds?: ReadonlySet<string>;
}

const ROLE_LABELS = {
  user: "You",
  assistant: "Assistant",
  system: "System",
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

  return (
    <box
      width="100%"
      flexDirection="column"
      borderStyle="single"
      borderColor={roleStyle.borderColor}
      backgroundColor={roleStyle.backgroundColor}
      paddingX={1}
      paddingY={1}
      gap={1}
    >
      <text fg={roleStyle.labelColor}>{ROLE_LABELS[message.role]}</text>
      <box width="100%" flexDirection="column" gap={1}>
        {renderedParts}
      </box>
    </box>
  );
}
