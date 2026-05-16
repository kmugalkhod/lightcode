import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, safeValidateUIMessages, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChatMessage } from "../components/chat/chat-message";
import { ChatShell } from "../components/chat/chat-shell";
import { ChatTextArea } from "../components/chat/chat-text-area";
import { chatSessionHistoryResponseSchema } from "../lib/chat-schema-types";
import type { ScreenProps } from "../navigation/route-registry";
import { chatRouteStateSchema } from "../navigation/route-state";

const apiBaseUrl = Bun.env.LIGHTCODE_API_URL ?? "http://localhost:3000";
const chatApiUrl = `${apiBaseUrl}/chat`;
type ChatUIMessage = UIMessage;

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message;
  }

  return fallback;
}

async function validatePersistedMessages(messages: unknown): Promise<UIMessage[]> {
  if (!Array.isArray(messages)) {
    return [];
  }

  const validated: UIMessage[] = [];

  for (const message of messages) {
    const result = await safeValidateUIMessages({
      messages: [message],
    });

    if (!result.success || result.data.length === 0) {
      continue;
    }

    validated.push(result.data[0]);
  }

  return validated;
}

export function ChatScreen({ routeState }: ScreenProps<"chat">) {
  const parsedRouteState = useMemo(
    () => chatRouteStateSchema.safeParse(routeState),
    [routeState],
  );
  const initialPrompt = parsedRouteState.success ? parsedRouteState.data.input.trim() : "";
  const skipHistoryLoad = parsedRouteState.success
    ? parsedRouteState.data.skipHistoryLoad ?? false
    : false;
  const fallbackSessionIdRef = useRef(crypto.randomUUID());
  const sessionId = parsedRouteState.success
    ? parsedRouteState.data.sessionId
    : fallbackSessionIdRef.current;
  const submittedInitialPromptRef = useRef<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(true);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: chatApiUrl,
        body: { sessionId },
      }),
    [sessionId],
  );

  const { messages, setMessages, sendMessage, error, status } = useChat<ChatUIMessage>({
    id: sessionId,
    transport,
  });

  useEffect(() => {
    let cancelled = false;
    submittedInitialPromptRef.current = null;
    setHistoryError(null);
    setIsHistoryLoading(true);

    async function loadPersistedMessages() {
      if (skipHistoryLoad) {
        setMessages([]);
        setIsHistoryLoading(false);
        return;
      }

      try {
        const response = await fetch(`${chatApiUrl}/${encodeURIComponent(sessionId)}`);

        if (!response.ok) {
          throw new Error(`Unable to load chat history (HTTP ${response.status}).`);
        }

        const rawPayload = await response.json();
        const parsedPayload = chatSessionHistoryResponseSchema.safeParse(rawPayload);

        if (!parsedPayload.success) {
          throw new Error("Server returned an invalid chat history response.");
        }

        const validatedMessages = await validatePersistedMessages(parsedPayload.data.messages);

        if (cancelled) {
          return;
        }

        setMessages(validatedMessages);
      } catch (historyLoadError) {
        if (cancelled) {
          return;
        }

        setMessages([]);
        setHistoryError(getErrorMessage(historyLoadError, "Unable to load persisted chat history."));
      } finally {
        if (!cancelled) {
          setIsHistoryLoading(false);
        }
      }
    }

    void loadPersistedMessages();

    return () => {
      cancelled = true;
    };
  }, [sessionId, setMessages, skipHistoryLoad]);

  useEffect(() => {
    if (isHistoryLoading) {
      return;
    }

    if (!initialPrompt || submittedInitialPromptRef.current === initialPrompt) {
      return;
    }

    if (messages.length > 0) {
      return;
    }

    submittedInitialPromptRef.current = initialPrompt;
    void sendMessage({ text: initialPrompt });
  }, [initialPrompt, isHistoryLoading, messages.length, sendMessage]);

  const isStreaming = status === "submitted" || status === "streaming";
  const isLoading = isHistoryLoading || isStreaming;
  const errorMessage = historyError ?? error?.message ?? null;

  return (
    <ChatShell
      hasMessages={messages.length > 0}
      isLoading={isLoading}
      loadingLabel={isHistoryLoading ? "Loading conversation..." : "Thinking..."}
      errorMessage={errorMessage}
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
