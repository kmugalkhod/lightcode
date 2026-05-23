import { sessionPathParamsSchema } from "@lightcode/ai";
import { sessionMessagesResponseSchema } from "@lightcode/ai";
import { useCodingSessionChat } from "@lightcode/ai/react";
import { useCallback, useMemo } from "react";
import { useLocation, useParams } from "react-router";
import { ChatMessage } from "../components/chat/chat-message";
import { ChatShell } from "../components/chat/chat-shell";
import { ChatTextArea } from "../components/chat/chat-text-area";
import { client } from "../lib/client";
import { coerceSessionRouteLocationState } from "../navigation/route-state";

export function ChatScreen() {
  const routeParams = useParams();
  const location = useLocation();

  const parsedRouteParams = useMemo(
    () => sessionPathParamsSchema.safeParse(routeParams),
    [routeParams],
  );

  const locationState = useMemo(
    () => coerceSessionRouteLocationState(location.state),
    [location.state],
  );

  const initialPrompt = (locationState.input ?? "").trim();
  const skipHistoryLoad = locationState.skipHistoryLoad ?? false;
  const sessionId = parsedRouteParams.success ? parsedRouteParams.data.id : "";
  const isSessionIdValid = parsedRouteParams.success;

  const chatApi = useMemo(() => {
    const chatApiUrl = client.sessions[":id"].chat.$url({
      param: { id: sessionId },
    });

    return chatApiUrl.toString();
  }, [sessionId]);

  const loadPersistedMessages = useCallback(async () => {
    const response = await client.sessions[":id"].messages.$get({
      param: { id: sessionId },
    });

    if (!response.ok) {
      throw new Error(`Unable to load chat history (HTTP ${response.status}).`);
    }

    const rawPayload = await response.json();
    const parsedPayload = sessionMessagesResponseSchema.safeParse(rawPayload);
    if (!parsedPayload.success) {
      throw new Error("Server returned an invalid chat history response.");
    }

    return parsedPayload.data;
  }, [sessionId]);

  const {
    messages,
    pendingApprovals,
    submitInput,
    errorMessage,
    isLoading,
    isStreaming,
  } = useCodingSessionChat({
    chatApi,
    initialPrompt,
    isSessionIdValid,
    loadPersistedMessages,
    sessionId,
    skipHistoryLoad,
    cwd: process.cwd(),
  });

  return (
    <ChatShell
      hasMessages={messages.length > 0}
      messageCount={messages.length}
      errorMessage={errorMessage}
      inputArea={
        <ChatTextArea
          placeholder={isLoading ? "Waiting for response..." : "Reply..."}
          focused={!isLoading && isSessionIdValid}
          disabled={isLoading || !isSessionIdValid}
          beforeInput={
            pendingApprovals.length > 0 ? (
              <box flexDirection="column" gap={1}>
                <text fg="#F59E0B">
                  {pendingApprovals.length} tool approval
                  {pendingApprovals.length === 1 ? "" : "s"} pending
                </text>
                {pendingApprovals.map((approval, index) => (
                  <text key={approval.toolCallId} fg="#D4D4D4">
                    [{index + 1}] {approval.summary}
                  </text>
                ))}
              </box>
            ) : null
          }
          footer={
            pendingApprovals.length > 0 ? (
              <text fg="#8A8A8A">
                Use approve/deny (or yes/no) with optional index. Example: approve 1
              </text>
            ) : (
              <text fg="#8A8A8A">Working directory: {process.cwd()}</text>
            )
          }
          onSubmit={submitInput}
        />
      }
    >
      {messages.map((message) => (
        <ChatMessage key={message.id} message={message} />
      ))}
      {isStreaming ? (
        <box paddingX={1}>
          <text fg="#A78BFA">Assistant is thinking...</text>
        </box>
      ) : null}
    </ChatShell>
  );
}
