import { isToolUIPart, type UIMessage } from "ai";
import { ChatMessageErrorPart } from "./chat-message-error-part";
import { ChatMessageReasoningPart } from "./chat-message-reasoning-part";
import { ChatMessageTextPart } from "./chat-message-text-part";
import { ChatMessageToolInvocationPart } from "./chat-message-tool-invocation-part";

interface ChatMessageProps {
  message: UIMessage;
}

const ROLE_LABELS = {
  user: "You",
  assistant: "Assistant",
  system: "System",
} satisfies Record<UIMessage["role"], string>;

const ROLE_STYLES = {
  user: {
    labelColor: "#93C5FD",
    borderColor: "#1E3A5F",
    backgroundColor: "#0B1220",
  },
  assistant: {
    labelColor: "#86EFAC",
    borderColor: "#1E4D34",
    backgroundColor: "#07140E",
  },
  system: {
    labelColor: "#A3A3A3",
    borderColor: "#3A3A3A",
    backgroundColor: "#141414",
  },
} satisfies Record<UIMessage["role"], {
  labelColor: string;
  borderColor: string;
  backgroundColor: string;
}>;

export function ChatMessage({ message }: ChatMessageProps) {
  const roleStyle = ROLE_STYLES[message.role];
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
        return <ChatMessageToolInvocationPart key={key} part={part} />;
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
