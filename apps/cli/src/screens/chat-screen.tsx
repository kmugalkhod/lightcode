import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, safeValidateUIMessages, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router";
import { z } from "zod";
import { ChatMessage } from "../components/chat/chat-message";
import { ChatShell } from "../components/chat/chat-shell";
import { ChatTextArea } from "../components/chat/chat-text-area";
import { sessionMessagesResponseSchema } from "../lib/chat-schema-types";
import { coerceSessionRouteLocationState } from "../navigation/route-state";

const apiBaseUrl = Bun.env.LIGHTCODE_API_URL ?? "http://localhost:3000";
const sessionRouteParamsSchema = z.object({
  id: z.string().min(1),
});

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

export function ChatScreen() {
  const routeParams = useParams();
  const location = useLocation();
  const parsedRouteParams = useMemo(
    () => sessionRouteParamsSchema.safeParse(routeParams),
    [routeParams]
  );
  const locationState = useMemo(
    () => coerceSessionRouteLocationState(location.state),
    [location.state]
  );
  const initialPrompt = (locationState.input ?? "").trim();
  const skipHistoryLoad = locationState.skipHistoryLoad ?? false;
  const sessionId = parsedRouteParams.success ? parsedRouteParams.data.id : "";
  const isSessionIdValid = parsedRouteParams.success;
  const submittedInitialPromptRef = useRef<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(true);

  const transport = useMemo(() => {
    const encodedSessionId = encodeURIComponent(sessionId);

    return new DefaultChatTransport({
      api: `${apiBaseUrl}/sessions/${encodedSessionId}/chat`,
    });
  }, [sessionId]);

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
      if (!isSessionIdValid) {
        setMessages([]);
        setHistoryError("Invalid session route.");
        setIsHistoryLoading(false);
        return;
      }

      if (skipHistoryLoad) {
        setMessages([]);
        setIsHistoryLoading(false);
        return;
      }

      try {
        const response = await fetch(`${apiBaseUrl}/sessions/${encodeURIComponent(sessionId)}/messages`);

        if (!response.ok) {
          throw new Error(`Unable to load chat history (HTTP ${response.status}).`);
        }

        const rawPayload = await response.json();
        const parsedPayload = sessionMessagesResponseSchema.safeParse(rawPayload);

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
  }, [isSessionIdValid, sessionId, setMessages, skipHistoryLoad]);

  useEffect(() => {
    if (!isSessionIdValid) {
      return;
    }

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
  }, [initialPrompt, isHistoryLoading, isSessionIdValid, messages.length, sendMessage]);

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
          focused={!isLoading && isSessionIdValid}
          disabled={isLoading || !isSessionIdValid}
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
