import {
  codingAgentModes,
  cycleCodingAgentMode,
  defaultCodingAgentMode,
  type PermissionMode,
  sessionMessagesResponseSchema,
  sessionPathParamsSchema,
} from "@lightcode/ai";
import { useCodingSessionChat } from "@lightcode/ai/react";
import { useKeyboard } from "@opentui/react";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { SlashPageMenu } from "../commands/slash-page-menu";
import {
  ChatInteractionPopup,
  type ChatInteractionSubmitPayload,
} from "../components/chat/chat-interaction-popup";
import { ChatMessage } from "../components/chat/chat-message";
import { ChatShell } from "../components/chat/chat-shell";
import { ChatTextArea } from "../components/chat/chat-text-area";
import { ChatTodoStatusCard } from "../components/chat/chat-todo-status-card";
import { ChatToolApprovalCard } from "../components/chat/chat-tool-approval-card";
import { LoadingTimer } from "../components/chat/loading-timer";
import { useLoadingTimer } from "../hooks/use-loading-timer";
import { client } from "../lib/client";
import {
  getSlashPageRoutes,
  type AnyRouteDefinition,
} from "../navigation/route-registry";
import { coerceSessionRouteLocationState } from "../navigation/route-state";
import { useAppState } from "../state/app-state";
import { cliTheme } from "../ui/cli-theme";

const autoImplementationInstruction =
  "Please implement the approved plan now. Execute the work end-to-end and summarize completed changes.";
const defaultPlanRevisionRequest =
  "Please revise the plan with a different approach and ask clarifying questions if needed.";
const defaultPromptDismissResponse =
  "I want to skip this question for now. Please continue with reasonable assumptions and state them clearly.";
const planConfirmationAcceptKeywords = [
  "yes",
  "y",
  "ok",
  "okay",
  "proceed",
  "continue",
  "implement",
  "start",
  "go",
];
const planConfirmationReviseKeywords = [
  "no",
  "n",
  "revise",
  "change",
  "modify",
  "update",
  "adjust",
  "different",
  "refine",
  "rework",
];

function shouldImplementApprovedPlan(response: ChatInteractionSubmitPayload): boolean {
  if (response.selectedValue === "yes") {
    return true;
  }

  if (response.selectedValue === "no") {
    return false;
  }

  const normalizedAnswer = response.answer.trim().toLowerCase();
  if (!normalizedAnswer) {
    return false;
  }

  const normalizedTokens = normalizedAnswer.match(/[a-z]+/g) ?? [];
  const tokenSet = new Set(normalizedTokens);
  const hasAcceptKeyword = planConfirmationAcceptKeywords.some((keyword) =>
    tokenSet.has(keyword),
  );
  const hasReviseKeyword = planConfirmationReviseKeywords.some((keyword) =>
    tokenSet.has(keyword),
  );

  if (hasReviseKeyword) {
    return false;
  }

  return hasAcceptKeyword;
}

function getLatestAssistantMessage(messages: UIMessage[]): UIMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      return message;
    }
  }

  return null;
}

function collectMessageText(message: UIMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((segment) => segment.length > 0)
    .join("\n");
}

function hasProposedPlanBlock(message: UIMessage): boolean {
  const text = collectMessageText(message);
  return text.includes("<proposed_plan>") && text.includes("</proposed_plan>");
}

export function ChatScreen() {
  const routeParams = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const {
    slashMenuOpen,
    slashMenuQuery,
    setSlashMenuQuery,
    slashMenuSelected,
    setSlashMenuSelected,
    openSlashMenu,
    closeSlashMenu,
  } = useAppState();

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
  const [mode, setMode] = useState(locationState.mode ?? defaultCodingAgentMode);
  const [permissionMode, setPermissionMode] = useState<PermissionMode | undefined>(
    locationState.permissionMode,
  );
  const [planConfirmationMessageId, setPlanConfirmationMessageId] = useState<string | null>(null);
  const [handledPlanMessageIds, setHandledPlanMessageIds] = useState<string[]>([]);
  const [queuedImplementationInstruction, setQueuedImplementationInstruction] = useState<string | null>(null);
  const slashRoutes = getSlashPageRoutes(slashMenuQuery);
  const selectedSlashRouteIndex = Math.min(
    slashMenuSelected,
    Math.max(slashRoutes.length - 1, 0),
  );

  const syncSlashMenuFromInput = useCallback(
    (text: string) => {
      const firstLine = text.split(/\r?\n/, 1)[0] ?? "";

      if (!firstLine.startsWith("/")) {
        if (slashMenuOpen) {
          closeSlashMenu();
        }
        return;
      }

      if (!slashMenuOpen) {
        openSlashMenu();
      }

      setSlashMenuQuery(firstLine);
      setSlashMenuSelected(0);
    },
    [
      closeSlashMenu,
      openSlashMenu,
      setSlashMenuQuery,
      setSlashMenuSelected,
      slashMenuOpen,
    ],
  );

  useEffect(() => {
    setMode(locationState.mode ?? defaultCodingAgentMode);
    setPermissionMode(locationState.permissionMode);
  }, [locationState.mode, locationState.permissionMode, sessionId]);

  useEffect(() => {
    setPlanConfirmationMessageId(null);
    setHandledPlanMessageIds([]);
    setQueuedImplementationInstruction(null);
  }, [sessionId]);

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

    if (parsedPayload.data.session) {
      if (!locationState.mode) {
        setMode(parsedPayload.data.session.mode);
      }

      if (!locationState.permissionMode) {
        setPermissionMode(parsedPayload.data.session.permissionMode ?? undefined);
      }
    }

    return parsedPayload.data;
  }, [locationState.mode, locationState.permissionMode, sessionId]);

  const {
    messages,
    pendingApprovals,
    pendingUserPrompts,
    respondToUserPrompt,
    resolveAllToolApprovals,
    resolveToolApproval,
    sendDirectMessage,
    submitInput,
    errorMessage,
    isLoading,
    isStreaming,
    todos,
  } = useCodingSessionChat({
    chatApi,
    initialPrompt,
    isSessionIdValid,
    loadPersistedMessages,
    sessionId,
    skipHistoryLoad,
    cwd: process.cwd(),
    mode,
    permissionMode,
  });

  const elapsedSeconds = useLoadingTimer(isLoading || isStreaming);

  const getSlashRouteState = useCallback(
    (route: AnyRouteDefinition) => {
      if (route.id !== "status" && route.id !== "permissions") {
        return undefined;
      }

      return {
        sessionId,
        cwd: process.cwd(),
        mode,
        permissionMode,
        messageCount: messages.length,
        pendingApprovalCount: pendingApprovals.length,
      };
    },
    [messages.length, mode, pendingApprovals.length, permissionMode, sessionId],
  );

  const navigateIfSlashRoute = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed.startsWith("/")) {
        return false;
      }

      const normalized = trimmed.toLowerCase();
      const candidates = getSlashPageRoutes(trimmed);
      const exactMatch = candidates.find(
        (route) =>
          route.path.toLowerCase() === normalized ||
          route.shortcut.toLowerCase() === normalized,
      );
      const prefixMatches = candidates.filter(
        (route) =>
          route.path.toLowerCase().startsWith(normalized) ||
          route.shortcut.toLowerCase().startsWith(normalized),
      );
      const route = exactMatch ?? (prefixMatches.length === 1 ? prefixMatches[0] : null);

      if (!route) {
        openSlashMenu();
        setSlashMenuQuery(trimmed);
        setSlashMenuSelected(0);
        return true;
      }

      closeSlashMenu();
      navigate(route.path, { state: getSlashRouteState(route) });
      return true;
    },
    [
      closeSlashMenu,
      getSlashRouteState,
      navigate,
      openSlashMenu,
      setSlashMenuQuery,
      setSlashMenuSelected,
    ],
  );

  const submitChatInput = useCallback(
    (text: string) => {
      if (navigateIfSlashRoute(text)) {
        return;
      }

      submitInput(text);
    },
    [navigateIfSlashRoute, submitInput],
  );

  const modeDefinition = codingAgentModes[mode];
  const activeUserPrompt = pendingUserPrompts[0] ?? null;
  const pendingApprovalIds = useMemo(
    () => new Set(pendingApprovals.map((approval) => approval.toolCallId)),
    [pendingApprovals],
  );
  const planConfirmationOpen =
    mode === "plan" &&
    activeUserPrompt === null &&
    planConfirmationMessageId !== null;
  const hasBlockingPopup = activeUserPrompt !== null || planConfirmationOpen;
  const canTypeInChat = !isSessionIdValid
    ? false
    : hasBlockingPopup
      ? false
      : pendingApprovals.length > 0
        ? true
        : !isLoading;

  useEffect(() => {
    if (mode !== "plan") {
      setPlanConfirmationMessageId(null);
      return;
    }

    if (isStreaming || pendingUserPrompts.length > 0) {
      return;
    }

    const latestAssistantMessage = getLatestAssistantMessage(messages);
    if (!latestAssistantMessage) {
      return;
    }

    if (handledPlanMessageIds.includes(latestAssistantMessage.id)) {
      return;
    }

    if (!hasProposedPlanBlock(latestAssistantMessage)) {
      return;
    }

    setPlanConfirmationMessageId(latestAssistantMessage.id);
  }, [
    handledPlanMessageIds,
    messages,
    mode,
    isStreaming,
    pendingUserPrompts.length,
  ]);

  useEffect(() => {
    if (mode !== "build" || !queuedImplementationInstruction) {
      return;
    }

    sendDirectMessage(queuedImplementationInstruction);
    setQueuedImplementationInstruction(null);
  }, [mode, queuedImplementationInstruction, sendDirectMessage]);

  useKeyboard((keyEvent) => {
    const keyName = keyEvent.name.toLowerCase();
    const isPlainTab =
      (keyName === "tab" || keyEvent.sequence === "\t") &&
      !keyEvent.ctrl &&
      !keyEvent.meta &&
      !keyEvent.super &&
      !keyEvent.hyper &&
      !keyEvent.shift;
    const isCtrlT =
      keyName === "t" &&
      keyEvent.ctrl &&
      !keyEvent.meta &&
      !keyEvent.super &&
      !keyEvent.hyper &&
      !keyEvent.shift;

    if (!isPlainTab && !isCtrlT) {
      return;
    }

    if (!isSessionIdValid || hasBlockingPopup || slashMenuOpen) {
      return;
    }

    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    setMode((currentMode) => cycleCodingAgentMode(currentMode));
  });

  return (
    <box width="100%" height="100%">
      <ChatShell
        hasMessages={
          messages.length > 0 ||
          isStreaming ||
          pendingApprovals.length > 0 ||
          activeUserPrompt !== null ||
          planConfirmationOpen
        }
        messageCount={messages.length}
        errorMessage={errorMessage}
        inputArea={
          <ChatTextArea
            placeholder={isLoading ? "Waiting for response..." : "Reply..."}
            focused={canTypeInChat}
            disabled={!canTypeInChat}
            slashMenuOpen={slashMenuOpen}
            onTextChange={syncSlashMenuFromInput}
            beforeInput={slashMenuOpen ? (
              <SlashPageMenu
                query={slashMenuQuery}
                selectedIndex={selectedSlashRouteIndex}
                routes={slashRoutes}
              />
            ) : null}
            footer={
              <box flexDirection="row" justifyContent="space-between">
                {pendingApprovals.length > 0 ? (
                  <text fg={cliTheme.text.muted}>Use approval card or approve/deny commands</text>
                ) : hasBlockingPopup ? (
                  <text fg={cliTheme.text.muted}>Complete the inline prompt to continue</text>
                ) : slashMenuOpen ? (
                  <text fg={cliTheme.text.muted}>Choose a page or press Esc</text>
                ) : (
                  <text fg={cliTheme.text.muted}>Tab/Ctrl+T switch mode | Ctrl+P commands</text>
                )}
                <text>
                  <span fg={cliTheme.accent.primary}>{modeDefinition.label}</span>
                  <span fg={cliTheme.text.muted}> mode</span>
                </text>
              </box>
            }
            modeToggleHint
            onSubmit={submitChatInput}
          />
        }
      >
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            message={message}
            pendingApprovalIds={pendingApprovalIds}
          />
        ))}
        {isLoading || isStreaming ? <LoadingTimer elapsedSeconds={elapsedSeconds} /> : null}
        {isStreaming ? (
          <box paddingX={1}>
            <text fg={cliTheme.semantic.info}>Assistant is thinking...</text>
          </box>
        ) : null}
        {pendingApprovals.length > 0 ? (
          <ChatToolApprovalCard
            approvals={pendingApprovals}
            onResolve={resolveToolApproval}
            onResolveAll={resolveAllToolApprovals}
          />
        ) : null}
        {todos.length > 0 ? <ChatTodoStatusCard todos={todos} /> : null}
        {activeUserPrompt ? (
          <ChatInteractionPopup
            title={activeUserPrompt.header ?? "Question"}
            question={activeUserPrompt.question}
            options={activeUserPrompt.options.map((option) => ({
              value: option.label,
              label: option.label,
              description: option.description,
            }))}
            allowCustomResponse={activeUserPrompt.allowCustomResponse}
            placeholder={activeUserPrompt.placeholder ?? "Type your answer..."}
            submitLabel="Send answer"
            onSubmit={(response) => {
              const normalizedAnswer =
                response.answer.trim().length > 0
                  ? response.answer.trim()
                  : response.selectedOption ?? "";

              if (!normalizedAnswer) {
                return;
              }

              respondToUserPrompt({
                toolCallId: activeUserPrompt.toolCallId,
                answer: normalizedAnswer,
                selectedOption: response.selectedOption,
                source: response.source,
              });
            }}
            onCancel={() => {
              respondToUserPrompt({
                toolCallId: activeUserPrompt.toolCallId,
                answer: defaultPromptDismissResponse,
                source: "custom",
              });
            }}
          />
        ) : null}
        {planConfirmationOpen ? (
          <ChatInteractionPopup
            title="Plan Ready"
            question="Do you want to implement this plan now?"
            options={[
              {
                value: "yes",
                label: "Yes, implement now",
                description: "Switch to Build mode and start implementation immediately.",
              },
              {
                value: "no",
                label: "No, revise the plan",
                description: "Stay in Plan mode and request changes to the plan.",
              },
            ]}
            allowCustomResponse
            placeholder="What should change in the plan?"
            submitLabel="Confirm"
            requireCustomResponseForValues={["no"]}
            onSubmit={(response) => {
              if (!planConfirmationMessageId) {
                return;
              }

              setHandledPlanMessageIds((current) => [
                ...current,
                planConfirmationMessageId,
              ]);
              setPlanConfirmationMessageId(null);

              if (shouldImplementApprovedPlan(response)) {
                setMode("build");
                setQueuedImplementationInstruction(autoImplementationInstruction);
                return;
              }

              const revisionRequest =
                response.answer.trim().length > 0
                  ? response.answer.trim()
                  : defaultPlanRevisionRequest;
              sendDirectMessage(revisionRequest);
            }}
            onCancel={() => {
              if (!planConfirmationMessageId) {
                return;
              }

              setHandledPlanMessageIds((current) => [
                ...current,
                planConfirmationMessageId,
              ]);
              setPlanConfirmationMessageId(null);
              sendDirectMessage(defaultPlanRevisionRequest);
            }}
          />
        ) : null}
      </ChatShell>
    </box>
  );
}
