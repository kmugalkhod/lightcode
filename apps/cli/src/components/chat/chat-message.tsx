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

const ROLE_COLORS = {
  user: "#93C5FD",
  assistant: "#86EFAC",
  system: "#A3A3A3",
} satisfies Record<UIMessage["role"], string>;

export function ChatMessage({ message }: ChatMessageProps) {
  return (
    <box flexDirection="column">
      <text fg={ROLE_COLORS[message.role]}>{ROLE_LABELS[message.role]}</text>
      {message.parts.map((part, index) => {
        const key = `${message.id}:${part.type}:${index}`;

        if (part.type === "text") {
          return <ChatMessageTextPart key={key} part={part} />;
        }

        if (part.type === "reasoning") {
          return <ChatMessageReasoningPart key={key} part={part} />;
        }

        if (isToolUIPart(part)) {
          if (part.state === "output-error") {
            return (
              <ChatMessageErrorPart
                key={key}
                label={`Tool ${part.type}`}
                text={part.errorText}
              />
            );
          }

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
      })}
    </box>
  );
}
