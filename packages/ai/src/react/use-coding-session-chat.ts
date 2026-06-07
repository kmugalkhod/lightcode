import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithToolCalls,
  safeValidateUIMessages,
  type UIMessage,
} from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  codingToolInputSchemas,
  evaluateCodingToolPermission,
  resolveCodingPermissionMode,
  type CodingToolInputByName,
  type CodingToolName,
  type CodingToolOutputByName,
} from "../agent-tools";
import type { SessionMessagesResponse } from "../chat-schemas";
import {
  chatInteractionToolApprovalPayloadSchema,
  chatInteractionResolveRequestSchema,
  chatInteractionUpsertRequestSchema,
  chatInteractionUserPromptPayloadSchema,
  type ChatInteraction,
  type ChatInteractionListResponse,
  type ChatInteractionResolveRequest,
  type ChatInteractionUpsertRequest,
} from "../chat-interaction-schemas";
import { toSingleLinePreview } from "../common/output-utils";
import { createWorkspaceContext } from "../common/resolve-within-workspace";
import {
  executeCodingTool as executeCodingToolRuntime,
  type CodingToolExecutionOptions,
  parseCodingToolInput,
} from "../runtime-registry";
import {
  defaultCodingAgentMode,
  type CodingAgentMode,
} from "../coding-agent-modes";
import {
  formatPermissionDecision,
  isPermissionDeniedError,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRules,
} from "../permissions";
import type { SandboxConfig } from "../sandbox/config";
import {
  requestUserInputToolOutputSchema,
  type RequestUserInputToolOutput,
} from "../request-user-input/schema";
import { loadSessionTodos } from "../todo-write/runtime";
import type { TodoItem } from "../todo-write/schema";

export type ToolApprovalAction = "approve" | "deny";

type ApprovalCommandTarget = number | "all";

const recoverableDisconnectMessage =
  "Connection interrupted. Please retry or regenerate your last message.";
const buildModeAutoPromptResponse =
  "Proceed with implementation in Build mode. Continue without additional plan questions.";
const retryCommandPattern = /^\/?(retry|regenerate)$/i;

const codingToolNameSet = new Set<string>(Object.keys(codingToolInputSchemas));
type CodingToolInput = CodingToolInputByName[CodingToolName];
type CodingToolOutput = CodingToolOutputByName[CodingToolName];
type RequestUserInputToolInput = CodingToolInputByName["request_user_input"];

export interface PendingToolApproval {
  toolCallId: string;
  toolName: CodingToolName;
  input: CodingToolInput;
  summary: string;
  permissionDecision: PermissionDecision;
  cwd: string;
}

export interface PendingUserPromptOption {
  label: string;
  description?: string;
}

export interface PendingUserPrompt {
  toolCallId: string;
  header?: string;
  question: string;
  options: PendingUserPromptOption[];
  allowCustomResponse: boolean;
  placeholder?: string;
}

export interface RespondToUserPromptInput extends RequestUserInputToolOutput {
  toolCallId: string;
}

export interface UseCodingSessionChatOptions {
  chatApi: string;
  initialPrompt?: string;
  isSessionIdValid: boolean;
  loadPersistedMessages: () => Promise<SessionMessagesResponse>;
  loadPersistedInteractions?: () => Promise<ChatInteractionListResponse>;
  upsertInteraction?: (interaction: ChatInteractionUpsertRequest) => Promise<void>;
  resolveInteraction?: (
    toolCallId: string,
    resolution: ChatInteractionResolveRequest,
  ) => Promise<void>;
  sessionId: string;
  skipHistoryLoad?: boolean;
  cwd?: string;
  mode?: CodingAgentMode;
  permissionMode?: PermissionMode;
  allowedTools?: readonly CodingToolName[];
  permissionRules?: PermissionRules;
  sandbox?: SandboxConfig;
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

function isRequestUserInputToolName(
  toolName: CodingToolName,
): toolName is "request_user_input" {
  return toolName === "request_user_input";
}

function getStringInputProperty(input: CodingToolInput, key: string): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const value = Reflect.get(input, key);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function summarizeToolCall(toolName: CodingToolName, input: CodingToolInput): string {
  const target =
    getStringInputProperty(input, "path") ??
    getStringInputProperty(input, "command") ??
    getStringInputProperty(input, "query") ??
    getStringInputProperty(input, "pattern") ??
    getStringInputProperty(input, "revision") ??
    getStringInputProperty(input, "url");

  if (target) {
    return `${toolName} ${toSingleLinePreview(target)}`.trim();
  }

  return `${toolName} ${toSingleLinePreview(input)}`.trim();
}

async function executeCodingTool(
  toolName: CodingToolName,
  input: CodingToolInput,
  options: CodingToolExecutionOptions,
): Promise<CodingToolOutput> {
  return executeCodingToolRuntime(toolName, input, options);
}

function getToolErrorMessage(error: unknown, fallback: string) {
  if (isPermissionDeniedError(error)) {
    return formatPermissionDecision(error.decision);
  }

  return getErrorMessage(error, fallback);
}

function buildExecutionOptions({
  mode,
  cwd,
  sessionId,
  permissionMode,
  allowedTools,
  permissionRules,
  approved,
  sandbox,
}: {
  mode: CodingAgentMode;
  cwd: string;
  sessionId: string;
  permissionMode?: PermissionMode;
  allowedTools?: readonly CodingToolName[];
  permissionRules?: PermissionRules;
  approved?: boolean;
  sandbox?: SandboxConfig;
}): CodingToolExecutionOptions {
  return {
    mode,
    permissionMode: resolveCodingPermissionMode({ mode, permissionMode }),
    allowedTools,
    permissionRules,
    approved,
    cwd,
    sessionId,
    sandbox,
  };
}

function isTodoWriteOutput(
  toolName: CodingToolName,
  output: CodingToolOutput,
): output is CodingToolOutputByName["todo_write"] {
  return (
    toolName === "todo_write" &&
    typeof output === "object" &&
    output !== null &&
    Array.isArray(Reflect.get(output, "todos"))
  );
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

function isRecoverableChatErrorMessage(message: string) {
  return normalizeChatErrorMessage(message) === recoverableDisconnectMessage;
}

function isRetryCommand(input: string) {
  return retryCommandPattern.test(input.trim());
}

function queueToolOutput(outputResult: void | PromiseLike<void>) {
  if (!outputResult) {
    return;
  }

  void Promise.resolve(outputResult).catch((outputError) => {
    console.warn("Failed to add tool output.", outputError);
  });
}

function isIncompleteAssistantMessage(message: UIMessage) {
  if (message.role !== "assistant") {
    return false;
  }

  if (message.parts.length === 0) {
    return true;
  }

  return message.parts.some((part) => {
    if (
      (part.type === "text" || part.type === "reasoning") &&
      Reflect.get(part, "state") === "streaming"
    ) {
      return true;
    }

    return isToolUIPart(part) && part.state === "input-streaming";
  });
}

function trimIncompleteTrailingAssistantMessages(messages: UIMessage[]) {
  let endIndex = messages.length;

  while (
    endIndex > 0 &&
    isIncompleteAssistantMessage(messages[endIndex - 1])
  ) {
    endIndex -= 1;
  }

  return endIndex === messages.length ? messages : messages.slice(0, endIndex);
}

function hasUnresolvedToolParts(messages: UIMessage[]) {
  return messages.some((message) =>
    message.parts.some((part) => {
      if (!isToolUIPart(part)) {
        return false;
      }

      return ![
        "output-available",
        "output-error",
        "output-denied",
      ].includes(part.state);
    }),
  );
}

function hasActiveClientToolWork({
  messages,
  pendingApprovals,
  pendingUserPrompts,
}: {
  messages: UIMessage[];
  pendingApprovals: PendingToolApproval[];
  pendingUserPrompts: PendingUserPrompt[];
}) {
  const pendingApprovalIds = new Set(
    pendingApprovals.map((approval) => approval.toolCallId),
  );
  const pendingPromptIds = new Set(
    pendingUserPrompts.map((prompt) => prompt.toolCallId),
  );

  return messages.some((message) =>
    message.parts.some((part) => {
      if (!isToolUIPart(part)) {
        return false;
      }

      if (part.state === "input-streaming" || part.state === "approval-responded") {
        return true;
      }

      if (part.state !== "input-available") {
        return false;
      }

      return (
        !pendingApprovalIds.has(part.toolCallId) &&
        !pendingPromptIds.has(part.toolCallId)
      );
    }),
  );
}

function parseApprovalCommand(
  input: string,
): { action: ToolApprovalAction; target: ApprovalCommandTarget } | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const commandMatch = trimmed.match(/^\/?(approve|deny)(?:\s+(all|\d+))?$/i);
  if (commandMatch) {
    const actionToken = commandMatch[1].toLowerCase();
    const action: ToolApprovalAction =
      actionToken === "approve" ? "approve" : "deny";
    const targetToken = commandMatch[2]?.toLowerCase();
    const target =
      targetToken === "all"
        ? "all"
        : targetToken
          ? Math.max(0, Number(targetToken) - 1)
          : 0;

    return {
      action,
      target,
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

function restorePendingApproval(
  interaction: ChatInteraction,
): PendingToolApproval | null {
  if (interaction.kind !== "tool_approval" || interaction.status !== "pending") {
    return null;
  }

  const payloadResult = chatInteractionToolApprovalPayloadSchema.safeParse(
    interaction.payload,
  );
  if (!payloadResult.success) {
    return null;
  }

  try {
    const input = parseCodingToolInput(
      payloadResult.data.toolName,
      payloadResult.data.input,
    );

    return {
      toolCallId: interaction.toolCallId,
      toolName: payloadResult.data.toolName,
      input,
      summary: payloadResult.data.summary,
      permissionDecision: payloadResult.data.permissionDecision,
      cwd: payloadResult.data.cwd,
    };
  } catch {
    return null;
  }
}

function restorePendingUserPrompt(
  interaction: ChatInteraction,
): PendingUserPrompt | null {
  if (interaction.kind !== "user_prompt" || interaction.status !== "pending") {
    return null;
  }

  const payloadResult = chatInteractionUserPromptPayloadSchema.safeParse(
    interaction.payload,
  );
  if (!payloadResult.success) {
    return null;
  }

  return {
    toolCallId: interaction.toolCallId,
    header: payloadResult.data.header,
    question: payloadResult.data.question,
    options: payloadResult.data.options ?? [],
    allowCustomResponse: payloadResult.data.allowCustomResponse,
    placeholder: payloadResult.data.placeholder,
  };
}

export function useCodingSessionChat({
  chatApi,
  initialPrompt = "",
  isSessionIdValid,
  loadPersistedMessages,
  loadPersistedInteractions,
  upsertInteraction,
  resolveInteraction,
  sessionId,
  skipHistoryLoad = false,
  cwd = process.cwd(),
  mode = defaultCodingAgentMode,
  permissionMode,
  allowedTools,
  permissionRules,
  sandbox,
}: UseCodingSessionChatOptions) {
  const submittedInitialPromptRef = useRef<string | null>(null);
  const modeRef = useRef(mode);
  const cwdRef = useRef(cwd);
  const permissionModeRef = useRef(permissionMode);
  const allowedToolsRef = useRef(allowedTools);
  const permissionRulesRef = useRef(permissionRules);
  const sandboxRef = useRef(sandbox);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [toolExecutionError, setToolExecutionError] = useState<string | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(true);
  const [pendingApprovals, setPendingApprovals] = useState<PendingToolApproval[]>([]);
  const [pendingUserPrompts, setPendingUserPrompts] = useState<PendingUserPrompt[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);

  modeRef.current = mode;
  cwdRef.current = cwd;
  permissionModeRef.current = permissionMode;
  allowedToolsRef.current = allowedTools;
  permissionRulesRef.current = permissionRules;
  sandboxRef.current = sandbox;

  const transport = useMemo(() => {
    return new DefaultChatTransport({
      api: chatApi,
      body: () => ({
        cwd: cwdRef.current,
        mode: modeRef.current,
        permissionMode: permissionModeRef.current,
        allowedTools: allowedToolsRef.current,
        permissionRules: permissionRulesRef.current,
        sandbox: sandboxRef.current,
      }),
    });
  }, [chatApi]);

  const checkpointInteraction = useCallback(
    async (interaction: ChatInteractionUpsertRequest) => {
      if (!upsertInteraction) {
        return;
      }

      try {
        await upsertInteraction(interaction);
      } catch (interactionError) {
        console.warn("Failed to checkpoint chat interaction.", interactionError);
      }
    },
    [upsertInteraction],
  );

  const markInteractionResolved = useCallback(
    async (toolCallId: string, resolution: ChatInteractionResolveRequest) => {
      if (!resolveInteraction) {
        return;
      }

      try {
        await resolveInteraction(toolCallId, resolution);
      } catch (interactionError) {
        console.warn("Failed to resolve chat interaction.", interactionError);
      }
    },
    [resolveInteraction],
  );

  const {
    messages,
    setMessages,
    sendMessage,
    addToolOutput,
    clearError,
    error,
    status,
  } =
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
          queueToolOutput(
            addToolOutput({
              tool: toolName,
              toolCallId: toolCall.toolCallId,
              state: "output-error",
              errorText: getErrorMessage(toolError, "Invalid tool input payload."),
            }),
          );
          return;
        }

        if (isRequestUserInputToolName(toolName)) {
          if (mode !== "plan") {
            queueToolOutput(
              addToolOutput({
                tool: "request_user_input",
                toolCallId: toolCall.toolCallId,
                output: {
                  answer: buildModeAutoPromptResponse,
                  source: "custom",
                },
              }),
            );
            return;
          }

          const promptInput = parsedInput as RequestUserInputToolInput;
          const pendingPrompt: PendingUserPrompt = {
            toolCallId: toolCall.toolCallId,
            header: promptInput.header,
            question: promptInput.question,
            options: promptInput.options ?? [],
            allowCustomResponse: promptInput.allowCustomResponse,
            placeholder: promptInput.placeholder,
          };

          void checkpointInteraction(
            chatInteractionUpsertRequestSchema.parse({
              kind: "user_prompt",
              toolCallId: toolCall.toolCallId,
              payload: promptInput,
            }),
          );

          setPendingUserPrompts((current) => {
            if (current.some((item) => item.toolCallId === toolCall.toolCallId)) {
              return current;
            }

            return [...current, pendingPrompt];
          });

          return;
        }

        const permissionDecision = evaluateCodingToolPermission({
          toolName,
          input: parsedInput,
          mode,
          permissionMode,
          allowedTools,
          permissionRules,
        });

        if (permissionDecision.outcome === "deny") {
          queueToolOutput(
            addToolOutput({
              tool: toolName,
              toolCallId: toolCall.toolCallId,
              state: "output-error",
              errorText: formatPermissionDecision(permissionDecision),
            }),
          );
          return;
        }

        if (permissionDecision.outcome === "ask") {
          const pendingApproval: PendingToolApproval = {
            toolCallId: toolCall.toolCallId,
            toolName,
            input: parsedInput,
            summary: summarizeToolCall(toolName, parsedInput),
            permissionDecision,
            cwd,
          };

          void checkpointInteraction(
            chatInteractionUpsertRequestSchema.parse({
              kind: "tool_approval",
              toolCallId: toolCall.toolCallId,
              payload: {
                toolName,
                input: parsedInput,
                summary: pendingApproval.summary,
                permissionDecision,
                cwd,
              },
            }),
          );

          setPendingApprovals((previousApprovals) => {
            if (
              previousApprovals.some(
                (item) => item.toolCallId === toolCall.toolCallId,
              )
            ) {
              return previousApprovals;
            }

            return [...previousApprovals, pendingApproval];
          });

          return;
        }

        try {
          const output = await executeCodingTool(
            toolName,
            parsedInput,
            buildExecutionOptions({
              mode,
              cwd,
              sessionId,
              permissionMode,
              allowedTools,
              permissionRules,
              sandbox,
            }),
          );
          if (isTodoWriteOutput(toolName, output)) {
            setTodos(output.todos);
          }
          queueToolOutput(
            addToolOutput({
              tool: toolName,
              toolCallId: toolCall.toolCallId,
              output,
            }),
          );
        } catch (toolError) {
          queueToolOutput(
            addToolOutput({
              tool: toolName,
              toolCallId: toolCall.toolCallId,
              state: "output-error",
              errorText: getToolErrorMessage(toolError, "Tool execution failed."),
            }),
          );
        }
      },
    });

  const runApprovedTool = useCallback(
    async (approval: PendingToolApproval) => {
      try {
        const output = await executeCodingTool(
          approval.toolName,
          approval.input,
          buildExecutionOptions({
            mode,
            cwd,
            sessionId,
            permissionMode,
            allowedTools,
            permissionRules,
            approved: true,
            sandbox,
          }),
        );
        if (isTodoWriteOutput(approval.toolName, output)) {
          setTodos(output.todos);
        }
        await addToolOutput({
          tool: approval.toolName,
          toolCallId: approval.toolCallId,
          output,
        });
        await markInteractionResolved(
          approval.toolCallId,
          chatInteractionResolveRequestSchema.parse({
            status: "approved",
            response: output,
          }),
        );
      } catch (toolError) {
        const errorText = getToolErrorMessage(toolError, "Tool execution failed.");
        await addToolOutput({
          tool: approval.toolName,
          toolCallId: approval.toolCallId,
          state: "output-error",
          errorText,
        });
        await markInteractionResolved(approval.toolCallId, {
          status: "approved",
          response: {
            errorText,
          },
        });
      }
    },
    [
      addToolOutput,
      allowedTools,
      cwd,
      markInteractionResolved,
      mode,
      permissionMode,
      permissionRules,
      sandbox,
      sessionId,
    ],
  );

  const resolveToolApproval = useCallback(
    (action: ToolApprovalAction, index: number) => {
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
        void (async () => {
          await addToolOutput({
            tool: selectedApproval.toolName,
            toolCallId: selectedApproval.toolCallId,
            state: "output-error",
            errorText: "Tool execution denied by user.",
          });
          await markInteractionResolved(selectedApproval.toolCallId, {
            status: "denied",
            response: {
              errorText: "Tool execution denied by user.",
            },
          });
        })();
        return;
      }

      void runApprovedTool(selectedApproval);
    },
    [addToolOutput, markInteractionResolved, pendingApprovals, runApprovedTool],
  );

  const resolveAllToolApprovals = useCallback(
    (action: ToolApprovalAction) => {
      if (pendingApprovals.length === 0) {
        setToolExecutionError("No pending tool approvals.");
        return;
      }

      const selectedApprovals = [...pendingApprovals];
      setPendingApprovals([]);
      setToolExecutionError(null);

      if (action === "deny") {
        void (async () => {
          for (const approval of selectedApprovals) {
            await addToolOutput({
              tool: approval.toolName,
              toolCallId: approval.toolCallId,
              state: "output-error",
              errorText: "Tool execution denied by user.",
            });
            await markInteractionResolved(approval.toolCallId, {
              status: "denied",
              response: {
                errorText: "Tool execution denied by user.",
              },
            });
          }
        })();
        return;
      }

      void (async () => {
        for (const approval of selectedApprovals) {
          await runApprovedTool(approval);
        }
      })();
    },
    [addToolOutput, markInteractionResolved, pendingApprovals, runApprovedTool],
  );

  const respondToUserPrompt = useCallback(
    ({ toolCallId, ...rawResponse }: RespondToUserPromptInput) => {
      const pendingPrompt = pendingUserPrompts.find(
        (prompt) => prompt.toolCallId === toolCallId,
      );

      if (!pendingPrompt) {
        setToolExecutionError("No matching user prompt is pending.");
        return;
      }

      const parsedResponse = requestUserInputToolOutputSchema.safeParse(rawResponse);
      if (!parsedResponse.success) {
        setToolExecutionError("Invalid user prompt response.");
        return;
      }

      setToolExecutionError(null);
      setPendingUserPrompts((current) =>
        current.filter((prompt) => prompt.toolCallId !== toolCallId),
      );
      void (async () => {
        await addToolOutput({
          tool: "request_user_input",
          toolCallId,
          output: parsedResponse.data,
        });
        await markInteractionResolved(toolCallId, {
          status: "answered",
          response: parsedResponse.data,
        });
      })();
    },
    [addToolOutput, markInteractionResolved, pendingUserPrompts],
  );

  const canRetryRecoverableResponse = Boolean(
    error?.message && isRecoverableChatErrorMessage(error.message),
  );

  const retryRecoverableResponse = useCallback(async () => {
    if (!error?.message || !isRecoverableChatErrorMessage(error.message)) {
      setToolExecutionError("No recoverable response is waiting to retry.");
      return;
    }

    if (
      pendingApprovals.length > 0 ||
      pendingUserPrompts.length > 0 ||
      hasUnresolvedToolParts(messages)
    ) {
      setToolExecutionError(
        "Resolve pending tool approvals or user prompts before retrying.",
      );
      return;
    }

    const retryMessages = trimIncompleteTrailingAssistantMessages(messages);
    setMessages(retryMessages);
    clearError();
    setToolExecutionError(null);
    await sendMessage();
  }, [
    clearError,
    error?.message,
    messages,
    pendingApprovals.length,
    pendingUserPrompts.length,
    sendMessage,
    setMessages,
  ]);

  const submitInput = useCallback(
    (text: string) => {
      if (canRetryRecoverableResponse && isRetryCommand(text)) {
        void retryRecoverableResponse();
        return;
      }

      if (pendingApprovals.length > 0) {
        const approvalCommand = parseApprovalCommand(text);
        if (approvalCommand) {
          if (approvalCommand.target === "all") {
            resolveAllToolApprovals(approvalCommand.action);
          } else {
            resolveToolApproval(approvalCommand.action, approvalCommand.target);
          }
          return;
        }

        setToolExecutionError(
          "Tool approval pending. Use approve/deny with optional index or all, e.g. 'approve 1' or 'approve all'.",
        );
        return;
      }

      if (pendingUserPrompts.length > 0) {
        setToolExecutionError(
          "A user prompt is waiting for response. Please answer it in the inline prompt.",
        );
        return;
      }

      setToolExecutionError(null);
      void sendMessage({ text });
    },
    [
      pendingApprovals.length,
      pendingUserPrompts.length,
      canRetryRecoverableResponse,
      retryRecoverableResponse,
      resolveAllToolApprovals,
      resolveToolApproval,
      sendMessage,
    ],
  );

  const sendDirectMessage = useCallback(
    (text: string) => {
      const messageText = text.trim();
      if (!messageText) {
        return;
      }

      setToolExecutionError(null);
      void sendMessage({ text: messageText });
    },
    [sendMessage],
  );

  useEffect(() => {
    let cancelled = false;
    submittedInitialPromptRef.current = null;
    setHistoryError(null);
    setToolExecutionError(null);
    setPendingApprovals([]);
    setPendingUserPrompts([]);
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
        const [messagePayload, interactionPayload] = await Promise.all([
          loadPersistedMessages(),
          loadPersistedInteractions
            ? loadPersistedInteractions()
            : Promise.resolve({ interactions: [] }),
        ]);
        const validatedMessages = await validatePersistedMessages(
          messagePayload.messages,
        );
        const restoredApprovals = interactionPayload.interactions
          .map(restorePendingApproval)
          .filter((approval): approval is PendingToolApproval => approval !== null);
        const restoredPrompts = interactionPayload.interactions
          .map(restorePendingUserPrompt)
          .filter((prompt): prompt is PendingUserPrompt => prompt !== null);

        if (cancelled) {
          return;
        }

        setMessages(validatedMessages);
        setPendingApprovals(restoredApprovals);
        setPendingUserPrompts(restoredPrompts);
      } catch (historyLoadError) {
        if (cancelled) {
          return;
        }

        setMessages([]);
        setPendingApprovals([]);
        setPendingUserPrompts([]);
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
    loadPersistedInteractions,
    loadPersistedMessages,
    sessionId,
    setMessages,
    skipHistoryLoad,
  ]);

  useEffect(() => {
    if (mode === "plan" || pendingUserPrompts.length === 0) {
      return;
    }

    for (const pendingPrompt of pendingUserPrompts) {
      void (async () => {
        const output = {
          answer: buildModeAutoPromptResponse,
          source: "custom" as const,
        };
        await addToolOutput({
          tool: "request_user_input",
          toolCallId: pendingPrompt.toolCallId,
          output,
        });
        await markInteractionResolved(pendingPrompt.toolCallId, {
          status: "answered",
          response: output,
        });
      })();
    }

    setPendingUserPrompts([]);
    setToolExecutionError(null);
  }, [addToolOutput, markInteractionResolved, mode, pendingUserPrompts]);

  useEffect(() => {
    let active = true;

    async function refreshTodos() {
      try {
        const workspaceContext = createWorkspaceContext(cwd);
        const loadedTodos = await loadSessionTodos({
          sessionId,
          workspaceContext,
        });

        if (active) {
          setTodos(loadedTodos);
        }
      } catch {
        if (active) {
          setTodos([]);
        }
      }
    }

    void refreshTodos();

    return () => {
      active = false;
    };
  }, [cwd, sessionId]);

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

  const hasActiveToolWork = hasActiveClientToolWork({
    messages,
    pendingApprovals,
    pendingUserPrompts,
  });
  const isStreaming =
    status === "submitted" || status === "streaming" || hasActiveToolWork;
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
    pendingUserPrompts,
    canRetryRecoverableResponse,
    todos,
    retryRecoverableResponse,
    resolveAllToolApprovals,
    resolveToolApproval,
    sessionId,
    status,
    respondToUserPrompt,
    sendDirectMessage,
    submitInput,
    isSessionIdValid,
  };
}
