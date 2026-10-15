import {
  codingAgentModes,
  chatInteractionListResponseSchema,
  collectMessageText,
  cycleCodingAgentMode,
  defaultCodingAgentMode,
  getMessageUsageMetadata,
  retryReasonLabel,
  type ChatInteractionResolveRequest,
  type ChatInteractionUpsertRequest,
  type PermissionMode,
  type SessionContextState,
  sessionContextResponseSchema,
  sessionMessagesResponseSchema,
  sessionPathParamsSchema,
} from "@lightcode/ai";
import { useCodingSessionChat } from "@lightcode/ai/react";
import { networkFetch } from "@lightcode/shared/network";
import { useKeyboard, useRenderer } from "@opentui/react";
import type { FileUIPart } from "ai";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import path from "node:path";
import { useLocation, useNavigate, useParams } from "react-router";
import {
  findChatSlashAction,
  getChatSlashActionById,
  parseChatSlashArgs,
  type ChatActionTone,
  type ChatSlashActionDefinition,
} from "../commands/chat-slash-actions";
import { copyText } from "../lib/clipboard";
import { getSlashMenuItems } from "../commands/slash-menu-items";
import { SlashPageMenu } from "../commands/slash-page-menu";
import {
  ChatContextStateCard,
  ChatContextSummaryCard,
  isContextSummaryMessage,
} from "../components/chat/chat-context-summary-card";
import {
  ChatInteractionPopup,
} from "../components/chat/chat-interaction-popup";
import { ChatMessage } from "../components/chat/chat-message";
import { ChatShell } from "../components/chat/chat-shell";
import {
  BRANCH_GLYPH,
} from "../components/chat/ide-layout";
import { PanelToggleButton } from "../components/chat/panel-toggle-button";
import { useGitBranch } from "../components/chat/use-git-branch";
import { PermissionModeSelector } from "../components/chat/permission-mode-selector";
import { ChatTextArea } from "../components/chat/chat-text-area";
import { ChatTodoStatusCard } from "../components/chat/chat-todo-status-card";
import { ChatToolApprovalCard } from "../components/chat/chat-tool-approval-card";
import { LoadingTimer } from "../components/chat/loading-timer";
import { CopyModeOverlay } from "../components/chat/copy-mode-overlay";
import { useAutoContinueConfig } from "../hooks/use-auto-continue-config";
import { useModelBudgetInfo } from "../hooks/use-context-window";
import { useLoadingTimer } from "../hooks/use-loading-timer";
import { client } from "../lib/client";
import {
  getSlashPageRoutes,
  type AnyRouteDefinition,
} from "../navigation/route-registry";
import { coerceSessionRouteLocationState } from "../navigation/route-state";
import { useAppState } from "../state/app-state";
import { cliTheme } from "../ui/cli-theme";
import { estimateContextUsage } from "../utils/chat-context-utils";
import {
  computeSessionCostUsd,
  computeUsageCostUsd,
} from "../utils/usage-cost-utils";
import { resolveMentionAttachments } from "../utils/file-mentions";
import { isDownKey, isEnterKey, isEscapeKey, isUpKey } from "../utils/key-utils";
import { extractCodeBlocks } from "../utils/markdown-code";
import { listWorkspaceFiles } from "../utils/workspace-files";
import { Badge } from "../ui/components/badge";
import { useIdePanels } from "./chat/use-ide-panels";
import { IdeWorkspace } from "./chat/ide-workspace";
import {
  autoImplementationInstruction,
  defaultPlanRevisionRequest,
  defaultPromptDismissResponse,
  getLatestAssistantMessage,
  hasProposedPlanBlock,
  hasToolCallXmlLeak,
  isAutoContinueMessage,
  loadCodingSessionTodos,
  shouldImplementApprovedPlan,
} from "./chat/chat-screen-helpers";
import { contextHintLine } from "../commands/context-keys";

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
    requestedChatActionId,
    clearRequestedChatAction,
    changesPanelOpen,
    setChangesPanelOpen,
    toggleChangesPanel,
    setEditorActive,
    setChatFooterStatus,
    setChatRunAbortHandler,
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
  const [sessionCwd, setSessionCwd] = useState(process.cwd());
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [planConfirmationMessageId, setPlanConfirmationMessageId] = useState<string | null>(null);
  const [handledPlanMessageIds, setHandledPlanMessageIds] = useState<string[]>([]);
  const [queuedImplementationInstruction, setQueuedImplementationInstruction] = useState<string | null>(null);
  const [contextState, setContextState] = useState<SessionContextState | null>(null);
  const [actionNotice, setActionNotice] = useState<{
    text: string;
    tone: ChatActionTone;
  } | null>(null);
  const [permissionSelectorOpen, setPermissionSelectorOpen] = useState(false);
  // Whether the reply box holds text — the tool-approval card yields the
  // keyboard (Enter, d, a, …) to the reply box while a reply is in progress.
  const [draftHasText, setDraftHasText] = useState(false);
  const slashRoutes = getSlashMenuItems(slashMenuQuery, {
    host: "chat",
  });
  const selectedSlashRouteIndex = Math.min(
    slashMenuSelected,
    Math.max(slashRoutes.length - 1, 0),
  );

  const syncSlashMenuFromInput = useCallback(
    (text: string) => {
      setDraftHasText(text.trim().length > 0);
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
    const nextMode = locationState.mode ?? defaultCodingAgentMode;

    setMode((currentMode) =>
      currentMode === nextMode ? currentMode : nextMode,
    );
    setPermissionMode((currentPermissionMode) =>
      currentPermissionMode === locationState.permissionMode
        ? currentPermissionMode
        : locationState.permissionMode,
    );
  }, [locationState.mode, locationState.permissionMode, sessionId]);

  useEffect(() => {
    setPlanConfirmationMessageId(null);
    setHandledPlanMessageIds([]);
    setQueuedImplementationInstruction(null);
    setContextState(null);
    setActionNotice(null);
    setSessionCwd(process.cwd());
    setSessionTitle(null);
  }, [sessionId]);

  const chatApi = useMemo(() => {
    const chatApiUrl = client.sessions[":id"].turns.$url({
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

    setContextState(parsedPayload.data.contextState ?? null);

    const persistedSession = parsedPayload.data.session;
    if (persistedSession) {
      setSessionTitle(persistedSession.title);
      if (persistedSession.cwd) {
        setSessionCwd(persistedSession.cwd);
      }
      if (!locationState.mode) {
        setMode((currentMode) =>
          currentMode === persistedSession.mode
            ? currentMode
            : persistedSession.mode,
        );
      }

      if (!locationState.permissionMode) {
        const nextPermissionMode =
          persistedSession.permissionMode ?? undefined;
        setPermissionMode((currentPermissionMode) =>
          currentPermissionMode === nextPermissionMode
            ? currentPermissionMode
            : nextPermissionMode,
        );
      }
    }

    return parsedPayload.data;
  }, [locationState.mode, locationState.permissionMode, sessionId]);

  const loadPersistedInteractions = useCallback(async () => {
    const response = await client.sessions[":id"].interactions.$get({
      param: { id: sessionId },
      query: { status: "pending" },
    });

    if (!response.ok) {
      throw new Error(`Unable to load pending interactions (HTTP ${response.status}).`);
    }

    const rawPayload = await response.json();
    const parsedPayload = chatInteractionListResponseSchema.safeParse(rawPayload);
    if (!parsedPayload.success) {
      throw new Error("Server returned an invalid interaction response.");
    }

    return parsedPayload.data;
  }, [sessionId]);

  const upsertInteraction = useCallback(
    async (interaction: ChatInteractionUpsertRequest) => {
      const response = await client.sessions[":id"].interactions.$post({
        param: { id: sessionId },
        json: interaction,
      });

      if (!response.ok) {
        throw new Error(`Unable to checkpoint interaction (HTTP ${response.status}).`);
      }
    },
    [sessionId],
  );

  const resolveInteraction = useCallback(
    async (
      toolCallId: string,
      resolution: ChatInteractionResolveRequest,
    ) => {
      const response = await client.sessions[":id"].interactions[
        ":toolCallId"
      ].$patch({
        param: { id: sessionId, toolCallId },
        json: resolution,
      });

      if (!response.ok) {
        throw new Error(`Unable to resolve interaction (HTTP ${response.status}).`);
      }
    },
    [sessionId],
  );

  const autoContinueConfig = useAutoContinueConfig();
  const {
    abortActiveRun,
    autoContinueState,
    messages,
    pendingApprovals,
    pendingUserPrompts,
    canRetryRecoverableResponse,
    refreshPersistedMessages,
    respondToUserPrompt,
    resolveAllToolApprovals,
    resolveToolApproval,
    sendDirectMessage,
    submitInput,
    errorMessage,
    isLoading,
    isStreaming,
    status,
    todos,
  } = useCodingSessionChat({
    fetch: networkFetch,
    chatApi,
    initialPrompt,
    isSessionIdValid,
    loadPersistedMessages,
    loadPersistedInteractions,
    upsertInteraction,
    resolveInteraction,
    sessionId,
    skipHistoryLoad,
    cwd: sessionCwd,
    loadTodos: loadCodingSessionTodos,
    mode,
    permissionMode,
    autoContinue: autoContinueConfig,
  });

  useEffect(() => {
    const requestActive = status === "submitted" || status === "streaming";
    setChatRunAbortHandler(requestActive ? abortActiveRun : null);
    return () => setChatRunAbortHandler(null);
  }, [abortActiveRun, setChatRunAbortHandler, status]);

  const elapsedSeconds = useLoadingTimer(isLoading || isStreaming);
  const { contextWindow, pricing } = useModelBudgetInfo();
  const [mentionCandidates, setMentionCandidates] = useState<string[]>([]);

  // Tick once a second while a retry is pending so the backoff notice can count
  // down ("retrying in 4s") instead of looking frozen.
  const [retryNowMs, setRetryNowMs] = useState(() => Date.now());
  const retryAtMs =
    autoContinueState?.kind === "retry-error"
      ? autoContinueState.retryAtMs
      : undefined;
  useEffect(() => {
    if (!retryAtMs) {
      return;
    }
    const intervalId = setInterval(() => setRetryNowMs(Date.now()), 500);
    return () => clearInterval(intervalId);
  }, [retryAtMs]);

  const retryNoticeText = (() => {
    if (autoContinueState?.kind !== "retry-error") {
      return "";
    }
    const label = retryReasonLabel(autoContinueState.retryReason);
    const secondsLeft = retryAtMs
      ? Math.max(0, Math.ceil((retryAtMs - retryNowMs) / 1000))
      : 0;
    const timing = secondsLeft > 0 ? `in ${secondsLeft}s` : "now";
    return `${label} — retrying ${timing} (${autoContinueState.attempt})...`;
  })();

  useEffect(() => {
    let cancelled = false;

    async function loadMentionCandidates() {
      try {
        // Dedicated walker: the glob-search tool caps results at 200, which
        // silently hid most files from the picker in larger repos.
        const files = await listWorkspaceFiles(sessionCwd);
        if (!cancelled) {
          setMentionCandidates(files);
        }
      } catch {
        // The mention picker simply stays empty.
      }
    }

    void loadMentionCandidates();
    return () => {
      cancelled = true;
    };
  }, [sessionCwd]);

  const refreshContextState = useCallback(async () => {
    try {
      const response = await client.sessions[":id"].context.$get({
        param: { id: sessionId },
      });
      if (!response.ok) {
        return;
      }

      const parsed = sessionContextResponseSchema.safeParse(await response.json());
      if (parsed.success) {
        setContextState(parsed.data.contextState);
      }
    } catch {
      // Context state is cosmetic; ignore refresh failures.
    }
  }, [sessionId]);

  // Auto-compaction happens server-side during streaming; refresh the stored
  // context state whenever a stream finishes so the card stays accurate.
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      void refreshContextState();
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, refreshContextState]);

  const notifyChatAction = useCallback(
    (text: string, tone: ChatActionTone = "info") => {
      setActionNotice({ text, tone });
    },
    [],
  );

  const renderer = useRenderer();

  const idePanels = useIdePanels({
    changesPanelOpen,
    setChangesPanelOpen,
    sessionCwd,
    isStreaming,
    messages,
    setEditorActive,
  });
  const {
    activeFilePath,
    activeLineCount,
    agentTouched,
    changedByPath,
    changedSelectionPinned,
    changesFiles,
    chatFocused,
    closeFileTab,
    editorFocused,
    enterFileEdit,
    exitFileEdit,
    explorerFocused,
    fileTree,
    fileView,
    gitChanges,
    handleFileSaved,
    isEditingFile,
    narrowDrawer,
    openChangedFile,
    openFileContent,
    openFiles,
    panelFocused,
    panelTab,
    panelVisible,
    selectFileTab,
    selectedChangedPath,
    setPanelFocused,
    setPanelTab,
    toggleFileView,
    handlePanelKey,
  } = idePanels;

  // Branch for the session header; re-read when a run ends (the agent may
  // have switched branches).
  const gitBranch = useGitBranch(sessionCwd, isStreaming);

  const [copyModeOpen, setCopyModeOpen] = useState(false);
  const [copyModeIndex, setCopyModeIndex] = useState(0);

  // User + assistant messages that actually have text — the copyable targets.
  const copyableMessages = useMemo(
    () =>
      messages.filter(
        (message) =>
          (message.role === "user" || message.role === "assistant") &&
          collectMessageText(message).trim().length > 0,
      ),
    [messages],
  );

  const copySelectedMessage = useCallback(
    async (kind: "text" | "code") => {
      const message = copyableMessages[copyModeIndex];
      if (!message) {
        return;
      }

      const fullText = collectMessageText(message);
      let payload = fullText;
      let label = "message";

      if (kind === "code") {
        const blocks = extractCodeBlocks(fullText);
        if (blocks.length === 0) {
          notifyChatAction("No code blocks in this message.", "error");
          return;
        }
        payload = blocks.map((block) => block.code).join("\n\n");
        label = blocks.length === 1 ? "code block" : "code blocks";
      }

      const copied = await copyText(renderer, payload);
      notifyChatAction(
        copied
          ? `Copied ${label} to clipboard (${payload.length} chars).`
          : "Copy failed: clipboard unavailable in this terminal.",
        copied ? "info" : "error",
      );
      setCopyModeOpen(false);
    },
    [copyModeIndex, copyableMessages, notifyChatAction, renderer],
  );

  const runChatSlashAction = useCallback(
    (action: ChatSlashActionDefinition, args = "") => {
      void action.run({
        sessionId,
        args,
        messages,
        setContextState,
        notify: notifyChatAction,
        setPermissionMode: setPermissionModeToState,
        copyToClipboard: (text: string) => copyText(renderer, text),
        isStreaming,
        abortActiveRun,
        refreshMessages: refreshPersistedMessages,
      });
    },
    [
      abortActiveRun,
      isStreaming,
      messages,
      notifyChatAction,
      refreshPersistedMessages,
      renderer,
      sessionId,
    ],
  );

  const updatePermissionMode = useCallback(
    async (newMode: PermissionMode) => {
      setPermissionMode(newMode);
      setPermissionSelectorOpen(false);

      try {
        await client.sessions[":id"].$patch({
          param: { id: sessionId },
          json: { permissionMode: newMode },
        });
        notifyChatAction(`Permission mode set to: ${newMode}`);
      } catch (error) {
        notifyChatAction(
          `Failed to update permission mode: ${error instanceof Error ? error.message : "unknown"}`,
          "error",
        );
      }
    },
    [sessionId],
  );

  // Local state setter callback for chat action context
  const setPermissionModeToState = useCallback((newMode: PermissionMode) => {
    setPermissionMode(newMode);
  }, []);

  useEffect(() => {
    if (!requestedChatActionId) {
      return;
    }

    const action = getChatSlashActionById(requestedChatActionId);
    clearRequestedChatAction();

    if (action) {
      // Special handling for selector actions - open the overlay instead of running
      if (action.id === "permission") {
        setPermissionSelectorOpen(true);
        return;
      }
      runChatSlashAction(action);
    }
  }, [clearRequestedChatAction, requestedChatActionId, runChatSlashAction]);

  const getSlashRouteState = useCallback(
    (route: AnyRouteDefinition) => {
      if (route.id !== "status" && route.id !== "permissions") {
        return undefined;
      }

      return {
        sessionId,
        cwd: sessionCwd,
        mode,
        permissionMode,
        messageCount: messages.length,
        pendingApprovalCount: pendingApprovals.length,
      };
    },
    [
      messages.length,
      mode,
      pendingApprovals.length,
      permissionMode,
      sessionCwd,
      sessionId,
    ],
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
    (text: string, files?: FileUIPart[]) => {
      // Slash commands are text-only; skip routing when an image is attached.
      if (!files || files.length === 0) {
        const action = findChatSlashAction(text);
        if (action) {
          closeSlashMenu();
          // Selector actions open an overlay; their run() is a placeholder.
          if (action.id === "permission") {
            setPermissionSelectorOpen(true);
            return;
          }
          runChatSlashAction(action, parseChatSlashArgs(text));
          return;
        }

        if (navigateIfSlashRoute(text)) {
          return;
        }
      }

      setActionNotice(null);
      void (async () => {
        const attachment = await resolveMentionAttachments(text, sessionCwd);
        submitInput(attachment.text, files, attachment.parts);
      })();
    },
    [
      closeSlashMenu,
      navigateIfSlashRoute,
      runChatSlashAction,
      sessionCwd,
      submitInput,
    ],
  );

  const modeDefinition = codingAgentModes[mode];
  const contextEstimate = estimateContextUsage(messages, contextWindow);
  // Session $ from per-model pricing; null (hidden) when pricing is unknown.
  const sessionCostUsd = useMemo(
    () => computeSessionCostUsd(messages, pricing),
    [messages, pricing],
  );
  const anchorVisibleInMessages =
    contextState !== null &&
    messages.some((message) => message.id === contextState.anchorMessageId);

  const lastAssistantMessage = getLatestAssistantMessage(messages);
  // Live output-token readout for the status line: prefer the provider's
  // reported count once the turn finishes, otherwise a rough estimate from the
  // streamed text so the number grows while generating.
  const liveOutputTokens = (() => {
    if (!lastAssistantMessage) {
      return 0;
    }
    const reported = getMessageUsageMetadata(lastAssistantMessage)?.usage
      ?.outputTokens;
    if (typeof reported === "number" && reported > 0) {
      return reported;
    }
    const text = collectMessageText(lastAssistantMessage);
    return text ? Math.ceil(text.length / 4) : 0;
  })();
  // Per-turn cost shown next to the token count once the turn's usage lands.
  const lastTurnCostUsd = lastAssistantMessage
    ? computeUsageCostUsd(
        getMessageUsageMetadata(lastAssistantMessage)?.usage,
        pricing,
      )
    : null;

  // Publish live chat metrics for the persistent app footer; cleared on
  // unmount so other screens don't show a stale meter.
  useEffect(() => {
    setChatFooterStatus({
      contextPercentage: contextEstimate.percentage,
      contextLevel: contextEstimate.level,
      compactedMessages: contextState?.coveredMessageCount ?? 0,
      sessionCostUsd,
    });
  }, [
    contextEstimate.percentage,
    contextEstimate.level,
    contextState?.coveredMessageCount,
    sessionCostUsd,
    setChatFooterStatus,
  ]);
  useEffect(() => {
    return () => setChatFooterStatus(null);
  }, [setChatFooterStatus]);
  const modelHasToolCallXmlLeak =
    !isLoading && !isStreaming && lastAssistantMessage
      ? hasToolCallXmlLeak(lastAssistantMessage)
      : false;

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

    setPlanConfirmationMessageId((currentMessageId) =>
      currentMessageId === latestAssistantMessage.id
        ? currentMessageId
        : latestAssistantMessage.id,
    );
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

  // Continuation after truncation/premature stops is handled inside
  // useCodingSessionChat (auto-continue with loop guards); the screen only
  // renders its status via autoContinueState.

  useKeyboard((keyEvent) => {
    const keyName = keyEvent.name.toLowerCase();

    // While copy mode is open it owns the keyboard.
    if (copyModeOpen) {
      if (isEscapeKey(keyName)) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        setCopyModeOpen(false);
        return;
      }
      if (isUpKey(keyName, { vim: true })) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        setCopyModeIndex((index) => Math.max(0, index - 1));
        return;
      }
      if (isDownKey(keyName, { vim: true })) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        setCopyModeIndex((index) =>
          Math.min(copyableMessages.length - 1, index + 1),
        );
        return;
      }
      if (isEnterKey(keyName) || keyName === "y") {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        void copySelectedMessage("text");
        return;
      }
      if (keyName === "c") {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        void copySelectedMessage("code");
        return;
      }
      // Swallow other keys so they don't leak into the transcript/input.
      return;
    }

    // While a file is open in the editable buffer, the focused editor textarea
    // owns every key (typing, Esc, Ctrl+S handled in FileEditor). Don't process
    // anything here.
    if (isEditingFile) {
      return;
    }

    // While the panel holds focus it owns navigation and swallows keys.
    if (handlePanelKey(keyEvent)) {
      return;
    }

    const isCtrlY =
      keyName === "y" &&
      keyEvent.ctrl &&
      !keyEvent.meta &&
      !keyEvent.super &&
      !keyEvent.hyper &&
      !keyEvent.shift;
    if (isCtrlY) {
      if (
        !isSessionIdValid ||
        hasBlockingPopup ||
        slashMenuOpen ||
        permissionSelectorOpen ||
        copyableMessages.length === 0
      ) {
        return;
      }
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      setCopyModeIndex(copyableMessages.length - 1);
      setCopyModeOpen(true);
      return;
    }

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

    // The permission selector owns Tab (cycles modes) while it is open.
    if (!isSessionIdValid || hasBlockingPopup || slashMenuOpen || permissionSelectorOpen) {
      return;
    }

    keyEvent.preventDefault();
    keyEvent.stopPropagation();

    // When the Changes panel is open, plain Tab moves focus into it (Ctrl+T
    // still cycles the agent mode). Otherwise Tab cycles the mode as before.
    if (isPlainTab && panelVisible) {
      setPanelFocused(true);
      return;
    }

    setMode((currentMode) => cycleCodingAgentMode(currentMode));
  });

  const chatShell = (
      <ChatShell
        title={sessionTitle ?? "New session"}
        context={[
          path.basename(sessionCwd) || sessionCwd,
          ...(gitBranch ? [`${BRANCH_GLYPH} ${gitBranch}`] : []),
        ]}
        focused={chatFocused}
        hasMessages={
          messages.length > 0 ||
          isStreaming ||
          pendingApprovals.length > 0 ||
          activeUserPrompt !== null ||
          planConfirmationOpen
        }
        messageCount={messages.length}
        errorMessage={errorMessage}
        headerRight={
          // Inside the IDE layout the top tab bar already offers Terminal/IDE
          // switching, so the toggle would be redundant chrome in a tight column.
          !panelVisible ? (
            <PanelToggleButton
              open={panelVisible}
              count={changesFiles.length}
              onToggle={toggleChangesPanel}
            />
          ) : null
        }
        inputArea={
          <ChatTextArea
            placeholder={isLoading ? "Waiting for response..." : "Reply... (@ to attach files)"}
            focused={canTypeInChat && !copyModeOpen && !permissionSelectorOpen && !panelFocused && !isEditingFile}
            disabled={!canTypeInChat || copyModeOpen || permissionSelectorOpen || panelFocused || isEditingFile}
            slashMenuOpen={slashMenuOpen}
            mentionCandidates={mentionCandidates}
            onTextChange={syncSlashMenuFromInput}
            beforeInput={slashMenuOpen ? (
              <SlashPageMenu
                query={slashMenuQuery}
                selectedIndex={selectedSlashRouteIndex}
                routes={slashRoutes}
              />
            ) : null}
            footer={
              <box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
                {/* The hint shrinks (single row, clipped) so it can never wrap
                    into the meta cluster in a narrow IDE chat column. */}
                <box flexShrink={1} height={1} overflow="hidden">
                  {copyModeOpen ? (
                    <text wrapMode="none" truncate fg={cliTheme.text.muted}>{contextHintLine("copy")}</text>
                  ) : panelFocused ? (
                    <text wrapMode="none" truncate fg={cliTheme.text.muted}>
                      {contextHintLine(panelTab === "files" ? "explorer" : "changes")}
                    </text>
                  ) : panelVisible ? (
                    <text wrapMode="none" truncate fg={cliTheme.text.muted}>{contextHintLine("ide")}</text>
                  ) : canRetryRecoverableResponse ? (
                    <text wrapMode="none" truncate fg={cliTheme.text.muted}>
                      {errorMessage && /rate.?limit/i.test(errorMessage)
                        ? "Rate-limited — wait a moment, /model to switch, or add provider credits"
                        : "Type retry or regenerate to try again"}
                    </text>
                  ) : pendingApprovals.length > 0 ? (
                    <text wrapMode="none" truncate fg={cliTheme.text.muted}>{contextHintLine("approval")}</text>
                  ) : hasBlockingPopup ? (
                    <text wrapMode="none" truncate fg={cliTheme.text.muted}>Complete the inline prompt to continue</text>
                  ) : slashMenuOpen ? (
                    <text wrapMode="none" truncate fg={cliTheme.text.muted}>{contextHintLine("slash")}</text>
                  ) : (
                    <text wrapMode="none" truncate fg={cliTheme.text.muted}>{contextHintLine("chat")}</text>
                  )}
                </box>
                <box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
                  {/* In the IDE layout the status bar already shows mode +
                      permission; repeating them here just crowds the column. */}
                  {panelVisible ? null : (
                    <>
                      <text>
                        <span fg={cliTheme.text.muted}>· </span>
                        <span fg={cliTheme.accent.primary}>{modeDefinition.label}</span>
                        <span fg={cliTheme.text.muted}> mode</span>
                      </text>
                      <Badge
                        tone={
                          permissionMode === "danger-full-access"
                            ? "error"
                            : permissionMode === "read-only"
                              ? "neutral"
                              : "accent"
                        }
                        label={permissionMode ?? "default"}
                      />
                    </>
                  )}
                </box>
              </box>
            }
            onSubmit={submitChatInput}
          />
        }
      >
        {contextState && !anchorVisibleInMessages ? (
          <ChatContextStateCard contextState={contextState} />
        ) : null}
        {messages.map((message) => (
          <Fragment key={message.id}>
            {isAutoContinueMessage(message) ? null : isContextSummaryMessage(
                message,
              ) ? (
              <ChatContextSummaryCard message={message} />
            ) : (
              <ChatMessage
                message={message}
                pendingApprovalIds={pendingApprovalIds}
              />
            )}
            {contextState && contextState.anchorMessageId === message.id ? (
              <ChatContextStateCard contextState={contextState} />
            ) : null}
          </Fragment>
        ))}
        {actionNotice ? (
          <box paddingX={1}>
            <text
              fg={
                actionNotice.tone === "error"
                  ? cliTheme.semantic.error
                  : cliTheme.semantic.info
              }
            >
              {actionNotice.text}
            </text>
          </box>
        ) : null}
        {modelHasToolCallXmlLeak ? (
          <box
            paddingX={1}
            paddingY={1}
            borderStyle="single"
            borderColor={cliTheme.semantic.warning}
            flexDirection="column"
            gap={1}
          >
            <text fg={cliTheme.semantic.warning}>
              Model compatibility issue: this model output raw tool call XML instead of invoking tools.
            </text>
            <text fg={cliTheme.text.muted}>
              Switch to a model with native function calling (Claude, GPT-4, Llama 3) via /model.
            </text>
          </box>
        ) : autoContinueState?.guardTripped ? (
          <box paddingX={1}>
            <text fg={cliTheme.semantic.warning}>
              {autoContinueState.guardTripped === "doom-loop"
                ? "Agent appears stuck repeating itself — automatic continuation stopped. Send a message to resume."
                : autoContinueState.guardTripped === "no-progress"
                  ? "The connection keeps dropping without making progress — automatic retry stopped. Send a message to resume."
                  : `Reached the automatic continuation limit (${autoContinueState.attempt}). Send a message to resume.`}
            </text>
          </box>
        ) : autoContinueState ? (
          <box paddingX={1}>
            <text fg={cliTheme.semantic.info}>
              {autoContinueState.kind === "continue-length"
                ? `Output limit hit — continuing automatically (${autoContinueState.attempt})...`
                : autoContinueState.kind === "retry-error"
                  ? retryNoticeText
                  : `Agent stopped early — continuing automatically (${autoContinueState.attempt})...`}
            </text>
          </box>
        ) : null}
        {isLoading || isStreaming ? (
          <LoadingTimer
            elapsedSeconds={elapsedSeconds}
            outputTokens={liveOutputTokens}
            costUsd={lastTurnCostUsd}
          />
        ) : null}
        {pendingApprovals.length > 0 ? (
          <ChatToolApprovalCard
            approvals={pendingApprovals}
            onResolve={resolveToolApproval}
            onResolveAll={resolveAllToolApprovals}
            hasDraftText={draftHasText}
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
            title="Plan review"
            question="Implement this plan now?"
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
        {permissionSelectorOpen ? (
          <PermissionModeSelector
            currentMode={permissionMode}
            onSelect={updatePermissionMode}
            onClose={() => setPermissionSelectorOpen(false)}
          />
        ) : null}
        {copyModeOpen ? (
          <CopyModeOverlay
            messages={copyableMessages}
            selectedIndex={Math.min(
              copyModeIndex,
              Math.max(copyableMessages.length - 1, 0),
            )}
          />
        ) : null}
      </ChatShell>
  );

  // In IDE mode the chat moves to the right column and the editor takes center
  // stage; otherwise the chat fills the screen as usual.
  if (!panelVisible) {
    return (
      <box width="100%" height="100%">
        {chatShell}
      </box>
    );
  }

  return (
    <IdeWorkspace
      panels={idePanels}
      chat={chatShell}
      sessionCwd={sessionCwd}
      modeLabel={modeDefinition.label}
      permissionMode={permissionMode}
      notify={notifyChatAction}
      setChangesPanelOpen={setChangesPanelOpen}
    />
  );
}
