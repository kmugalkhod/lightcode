import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  safeValidateUIMessages,
  type UIMessage,
} from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  codingToolInputSchemas,
  riskyCodingTools,
  type CodingToolInputByName,
  type CodingToolName,
  type CodingToolOutputByName,
} from "../agent-tools";
import type { SessionMessagesResponse } from "../chat-schemas";
import { toSingleLinePreview } from "../common/output-utils";
import {
  executeCodingTool as executeCodingToolRuntime,
  parseCodingToolInput,
} from "../runtime-registry";

type ApprovalAction = "approve" | "deny";

const recoverableDisconnectMessage =
  "Connection interrupted. Please retry or regenerate your last message.";

const approveAliases = new Set([
  "approve",
  "/approve",
  "approved",
  "yes",
  "y",
  "ok",
  "okay",
  "proceed",
  "continue",
]);

const denyAliases = new Set([
  "deny",
  "/deny",
  "denied",
  "no",
  "n",
  "reject",
  "cancel",
  "stop",
]);

const riskyToolNameSet = new Set<string>(riskyCodingTools);
const codingToolNameSet = new Set<string>(Object.keys(codingToolInputSchemas));
type CodingToolInput = CodingToolInputByName[CodingToolName];
type CodingToolOutput = CodingToolOutputByName[CodingToolName];

export interface PendingToolApproval {
  toolCallId: string;
  toolName: CodingToolName;
  input: CodingToolInput;
  summary: string;
}

export interface UseCodingSessionChatOptions {
  chatApi: string;
  initialPrompt?: string;
  isSessionIdValid: boolean;
  loadPersistedMessages: () => Promise<SessionMessagesResponse>;
  sessionId: string;
  skipHistoryLoad?: boolean;
  cwd?: string;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message;
  }

  return fallback;
}

function isCodingToolName(toolName: string): toolName is CodingToolName {
  return codingToolNameSet.has(toolName);
}

function isRiskyToolName(toolName: CodingToolName): boolean {
  return riskyToolNameSet.has(toolName);
}

function summarizeToolCall(toolName: CodingToolName, input: CodingToolInput): string {
  return `${toolName} ${toSingleLinePreview(input)}`.trim();
}

async function executeCodingTool(
  toolName: CodingToolName,
  input: CodingToolInput,
): Promise<CodingToolOutput> {
  return executeCodingToolRuntime(toolName, input);
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

function parseApprovalCommand(
  input: string,
): { action: ApprovalAction; index: number } | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const commandMatch = trimmed.match(/^\/?(approve|deny)(?:\s+(\d+))?$/i);
  if (commandMatch) {
    const actionToken = commandMatch[1].toLowerCase();
    const action: ApprovalAction =
      actionToken === "approve" ? "approve" : "deny";
    const index = commandMatch[2] ? Math.max(0, Number(commandMatch[2]) - 1) : 0;

    return {
      action,
      index,
    };
  }

  const words = trimmed
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return null;
  }

  const token = words[0];
  const indexToken = words[1];
  const parsedIndex =
    indexToken && /^\d+$/.test(indexToken)
      ? Math.max(0, Number(indexToken) - 1)
      : 0;

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

async function validatePersistedMessages(
  messages: SessionMessagesResponse["messages"],
): Promise<UIMessage[]> {
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

export function useCodingSessionChat({
  chatApi,
  initialPrompt = "",
  isSessionIdValid,
  loadPersistedMessages,
  sessionId,
  skipHistoryLoad = false,
  cwd = process.cwd(),
}: UseCodingSessionChatOptions) {
  const submittedInitialPromptRef = useRef<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [toolExecutionError, setToolExecutionError] = useState<string | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(true);
  const [pendingApprovals, setPendingApprovals] = useState<PendingToolApproval[]>([]);

  const transport = useMemo(() => {
    return new DefaultChatTransport({
      api: chatApi,
      body: () => ({
        cwd,
      }),
    });
  }, [chatApi, cwd]);

  const { messages, setMessages, sendMessage, addToolOutput, error, status } =
    useChat<UIMessage>({
      id: sessionId,
      transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
      onToolCall: async ({ toolCall }) => {
        if (toolCall.dynamic || !isCodingToolName(toolCall.toolName)) {
          return;
        }

        const toolName = toolCall.toolName;
        let parsedInput: CodingToolInput;

        try {
          parsedInput = parseCodingToolInput(toolName, toolCall.input);
        } catch (toolError) {
          addToolOutput({
            tool: toolName,
            toolCallId: toolCall.toolCallId,
            state: "output-error",
            errorText: getErrorMessage(toolError, "Invalid tool input payload."),
          });
          return;
        }

        if (isRiskyToolName(toolName)) {
          setPendingApprovals((previousApprovals) => {
            if (
              previousApprovals.some(
                (item) => item.toolCallId === toolCall.toolCallId,
              )
            ) {
              return previousApprovals;
            }

            return [
              ...previousApprovals,
              {
                toolCallId: toolCall.toolCallId,
                toolName,
                input: parsedInput,
                summary: summarizeToolCall(toolName, parsedInput),
              },
            ];
          });

          return;
        }

        try {
          const output = await executeCodingTool(toolName, parsedInput);
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
    [addToolOutput],
  );

  const resolveApproval = useCallback(
    (action: ApprovalAction, index: number) => {
      if (pendingApprovals.length === 0) {
        setToolExecutionError("No pending tool approvals.");
        return;
      }

      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= pendingApprovals.length
      ) {
        setToolExecutionError(
          `Invalid approval index. Use 1-${pendingApprovals.length}.`,
        );
        return;
      }

      const selectedApproval = pendingApprovals[index];
      setPendingApprovals((current) =>
        current.filter((item) => item.toolCallId !== selectedApproval.toolCallId),
      );
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
    [addToolOutput, pendingApprovals, runApprovedTool],
  );

  const submitInput = useCallback(
    (text: string) => {
      const approvalCommand = parseApprovalCommand(text);
      if (approvalCommand) {
        resolveApproval(approvalCommand.action, approvalCommand.index);
        return;
      }

      if (pendingApprovals.length > 0) {
        setToolExecutionError(
          "Tool approval pending. Use approve/deny (or yes/no) with optional index, e.g. 'approve 1'.",
        );
        return;
      }

      setToolExecutionError(null);
      void sendMessage({ text });
    },
    [pendingApprovals.length, resolveApproval, sendMessage],
  );

  useEffect(() => {
    let cancelled = false;
    submittedInitialPromptRef.current = null;
    setHistoryError(null);
    setToolExecutionError(null);
    setPendingApprovals([]);
    setIsHistoryLoading(true);

    async function loadMessages() {
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
        const validatedMessages = await validatePersistedMessages(
          (await loadPersistedMessages()).messages,
        );

        if (cancelled) {
          return;
        }

        setMessages(validatedMessages);
      } catch (historyLoadError) {
        if (cancelled) {
          return;
        }

        setMessages([]);
        setHistoryError(
          getErrorMessage(historyLoadError, "Unable to load persisted chat history."),
        );
      } finally {
        if (!cancelled) {
          setIsHistoryLoading(false);
        }
      }
    }

    void loadMessages();

    return () => {
      cancelled = true;
    };
  }, [
    isSessionIdValid,
    loadPersistedMessages,
    sessionId,
    setMessages,
    skipHistoryLoad,
  ]);

  useEffect(() => {
    if (!isSessionIdValid) {
      return;
    }

    if (isHistoryLoading) {
      return;
    }

    if (
      !initialPrompt ||
      submittedInitialPromptRef.current === initialPrompt.trim()
    ) {
      return;
    }

    if (messages.length > 0) {
      return;
    }

    submittedInitialPromptRef.current = initialPrompt.trim();
    void sendMessage({ text: initialPrompt.trim() });
  }, [initialPrompt, isHistoryLoading, isSessionIdValid, messages.length, sendMessage]);

  const isStreaming = status === "submitted" || status === "streaming";
  const isLoading = isHistoryLoading || isStreaming;
  const errorMessage =
    historyError ??
    toolExecutionError ??
    (error?.message ? normalizeChatErrorMessage(error.message) : null);

  return {
    errorMessage,
    isHistoryLoading,
    isLoading,
    isStreaming,
    messages,
    pendingApprovals,
    sessionId,
    status,
    submitInput,
    isSessionIdValid,
  };
}
