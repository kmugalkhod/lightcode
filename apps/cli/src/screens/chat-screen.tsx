import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  safeValidateUIMessages,
  type UIMessage,
} from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router";
import { z } from "zod";
import { ChatMessage } from "../components/chat/chat-message";
import { ChatShell } from "../components/chat/chat-shell";
import { ChatTextArea } from "../components/chat/chat-text-area";
import { sessionMessagesResponseSchema } from "../lib/chat-schema-types";
import { client } from "../lib/client";
import { coerceSessionRouteLocationState } from "../navigation/route-state";
import {
  executeCodingTool,
  isCodingToolName,
  isRiskyToolName,
  summarizeToolCall,
  type PendingToolApproval,
} from "../tools/tool-dispatcher";

const sessionRouteParamsSchema = z.object({
  id: z.string().min(1),
});

type ApprovalAction = "approve" | "deny";
const recoverableDisconnectMessage = "Connection interrupted. Please retry or regenerate your last message.";
const approveAliases = new Set(["approve", "/approve", "approved", "yes", "y", "ok", "okay", "proceed", "continue"]);
const denyAliases = new Set(["deny", "/deny", "denied", "no", "n", "reject", "cancel", "stop"]);

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message;
  }

  return fallback;
}

function normalizeChatErrorMessage(message: string) {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("failed to fetch") ||
    normalized.includes("networkerror") ||
    normalized.includes("socket") ||
    normalized.includes("connection") ||
    normalized.includes("aborted") ||
    normalized.includes("terminated")
  ) {
    return recoverableDisconnectMessage;
  }

  return message;
}

function parseApprovalCommand(input: string): { action: ApprovalAction; index: number } | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const commandMatch = trimmed.match(/^\/?(approve|deny)(?:\s+(\d+))?$/i);
  if (commandMatch) {
    const action = commandMatch[1].toLowerCase() as ApprovalAction;
    const index = commandMatch[2] ? Math.max(0, Number(commandMatch[2]) - 1) : 0;

    return {
      action,
      index,
    };
  }

  const words = trimmed.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    return null;
  }

  const token = words[0];
  const indexToken = words[1];
  const parsedIndex = indexToken && /^\d+$/.test(indexToken) ? Math.max(0, Number(indexToken) - 1) : 0;

  if (approveAliases.has(token)) {
    return {
      action: "approve",
      index: parsedIndex,
    };
  }

  if (denyAliases.has(token)) {
    return {
      action: "deny",
      index: parsedIndex,
    };
  }

  return null;
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
  const [toolExecutionError, setToolExecutionError] = useState<string | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(true);
  const [pendingApprovals, setPendingApprovals] = useState<PendingToolApproval[]>([]);

  const transport = useMemo(() => {
    const chatApiUrl = client.sessions[":id"].chat.$url({
      param: { id: sessionId },
    });

    return new DefaultChatTransport({
      api: chatApiUrl.toString(),
      body: () => ({
        cwd: process.cwd(),
      }),
    });
  }, [sessionId]);

  const { messages, setMessages, sendMessage, addToolOutput, error, status } = useChat<UIMessage>({
    id: sessionId,
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onToolCall: async ({ toolCall }) => {
      if (toolCall.dynamic || !isCodingToolName(toolCall.toolName)) {
        return;
      }

      const toolName = toolCall.toolName;

      if (isRiskyToolName(toolName)) {
        setPendingApprovals((previousApprovals) => {
          if (previousApprovals.some((item) => item.toolCallId === toolCall.toolCallId)) {
            return previousApprovals;
          }

          return [
            ...previousApprovals,
            {
              toolCallId: toolCall.toolCallId,
              toolName,
              input: toolCall.input,
              summary: summarizeToolCall(toolName, toolCall.input),
            },
          ];
        });

        return;
      }

      try {
        const output = await executeCodingTool(toolName, toolCall.input);
        addToolOutput({
          tool: toolName,
          toolCallId: toolCall.toolCallId,
          output,
        });
      } catch (toolError) {
        addToolOutput({
          tool: toolName,
          toolCallId: toolCall.toolCallId,
          state: "output-error",
          errorText: getErrorMessage(toolError, "Tool execution failed."),
        });
      }
    },
  });

  const runApprovedTool = useCallback(
    async (approval: PendingToolApproval) => {
      try {
        const output = await executeCodingTool(approval.toolName, approval.input);
        addToolOutput({
          tool: approval.toolName,
          toolCallId: approval.toolCallId,
          output,
        });
      } catch (toolError) {
        addToolOutput({
          tool: approval.toolName,
          toolCallId: approval.toolCallId,
          state: "output-error",
          errorText: getErrorMessage(toolError, "Tool execution failed."),
        });
      }
    },
    [addToolOutput]
  );

  const resolveApproval = useCallback(
    (action: ApprovalAction, index: number) => {
      if (pendingApprovals.length === 0) {
        setToolExecutionError("No pending tool approvals.");
        return;
      }

      if (!Number.isInteger(index) || index < 0 || index >= pendingApprovals.length) {
        setToolExecutionError(`Invalid approval index. Use 1-${pendingApprovals.length}.`);
        return;
      }

      const selectedApproval = pendingApprovals[index];
      setPendingApprovals((current) => current.filter((item) => item.toolCallId !== selectedApproval.toolCallId));
      setToolExecutionError(null);

      if (action === "deny") {
        addToolOutput({
          tool: selectedApproval.toolName,
          toolCallId: selectedApproval.toolCallId,
          state: "output-error",
          errorText: "Tool execution denied by user.",
        });
        return;
      }

      void runApprovedTool(selectedApproval);
    },
    [addToolOutput, pendingApprovals, runApprovedTool]
  );

  useEffect(() => {
    let cancelled = false;
    submittedInitialPromptRef.current = null;
    setHistoryError(null);
    setToolExecutionError(null);
    setPendingApprovals([]);
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
  const errorMessage =
    historyError ??
    toolExecutionError ??
    (error?.message ? normalizeChatErrorMessage(error.message) : null);

  return (
    <ChatShell
      hasMessages={messages.length > 0}
      messageCount={messages.length}
      errorMessage={errorMessage}
      inputArea={(
        <ChatTextArea
          placeholder={isLoading ? "Waiting for response..." : "Reply..."}
          focused={!isLoading && isSessionIdValid}
          disabled={isLoading || !isSessionIdValid}
          beforeInput={pendingApprovals.length > 0 ? (
            <box flexDirection="column" gap={1}>
              <text fg="#F59E0B">
                {pendingApprovals.length} tool approval{pendingApprovals.length === 1 ? "" : "s"} pending
              </text>
              {pendingApprovals.map((approval, index) => (
                <text key={approval.toolCallId} fg="#D4D4D4">
                  [{index + 1}] {approval.summary}
                </text>
              ))}
            </box>
          ) : null}
          footer={pendingApprovals.length > 0 ? (
            <text fg="#8A8A8A">Use approve/deny (or yes/no) with optional index. Example: approve 1</text>
          ) : (
            <text fg="#8A8A8A">Working directory: {process.cwd()}</text>
          )}
          onSubmit={(text) => {
            const approvalCommand = parseApprovalCommand(text);
            if (approvalCommand) {
              resolveApproval(approvalCommand.action, approvalCommand.index);
              return;
            }

            if (pendingApprovals.length > 0) {
              setToolExecutionError(
                "Tool approval pending. Use approve/deny (or yes/no) with optional index, e.g. 'approve 1'."
              );
              return;
            }

            setToolExecutionError(null);
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
