import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useRef } from "react";
import { ChatMessage } from "../components/chat/chat-message";
import { ChatShell } from "../components/chat/chat-shell";
import { ChatTextArea } from "../components/chat/chat-text-area";
import type { ScreenProps } from "../navigation/route-registry";
import { chatRouteStateSchema } from "../navigation/route-state";

const apiBaseUrl = Bun.env.LIGHTCODE_API_URL ?? "http://localhost:3000";
const chatApiUrl = `${apiBaseUrl}/chat`;
type ChatUIMessage = UIMessage;

export function ChatScreen({ routeState }: ScreenProps<"chat">) {
  const parsedRouteState = useMemo(
    () => chatRouteStateSchema.safeParse(routeState),
    [routeState],
  );
  const initialPrompt = parsedRouteState.success ? parsedRouteState.data.input.trim() : "";
  const submittedInitialPromptRef = useRef<string | null>(null);
  const { messages, sendMessage, error, status } = useChat<ChatUIMessage>({
    transport: new DefaultChatTransport({
      api: chatApiUrl,
    }),
  });
  const isLoading = status === "submitted" || status === "streaming";

  useEffect(() => {
    if (!initialPrompt || submittedInitialPromptRef.current === initialPrompt) {
      return;
    }

    submittedInitialPromptRef.current = initialPrompt;
    void sendMessage({ text: initialPrompt });
  }, [initialPrompt, sendMessage]);

  return (
    <ChatShell
      hasMessages={messages.length > 0}
      isLoading={isLoading}
      errorMessage={error?.message}
      inputArea={(
        <ChatTextArea
          placeholder={isLoading ? "Waiting for response..." : "Reply..."}
          focused={!isLoading}
          disabled={isLoading}
          onSubmit={(text) => {
            void sendMessage({ text });
          }}
        />
      )}
    >
      {messages.map((message) => (
        <ChatMessage key={message.id} message={message} />
      ))}
    </ChatShell>
  );
}
