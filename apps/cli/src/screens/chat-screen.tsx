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
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import type { FileUIPart, UIMessage } from "ai";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { containsProposedPlanBlock } from "../components/chat/chat-proposed-plan-card";
import {
  ChatInteractionPopup,
  type ChatInteractionSubmitPayload,
} from "../components/chat/chat-interaction-popup";
import { ChatMessage } from "../components/chat/chat-message";
import { ChatShell } from "../components/chat/chat-shell";
import {
  ChangesTab,
  EditorPane,
  ExplorerTree,
  TabButton,
  type FileViewMode,
  type PanelTab,
} from "../components/chat/file-explorer-panel";
import { IdeLayout } from "../components/chat/ide-layout";
import { PanelToggleButton } from "../components/chat/panel-toggle-button";
import {
  useChangedFiles,
  type ChangedFileChangeKind,
} from "../components/chat/use-changed-files";
import { useFileTree } from "../components/chat/use-file-tree";
import { useGitChanges } from "../components/chat/use-git-changes";
import { useFileContent } from "../components/chat/use-file-content";
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
import { borderStyleFor, cliTheme } from "../ui/cli-theme";
import { estimateContextUsage } from "../utils/chat-context-utils";
import {
  computeSessionCostUsd,
  computeUsageCostUsd,
} from "../utils/usage-cost-utils";
import { appendMentionAttachments } from "../utils/file-mentions";
import { isDownKey, isEnterKey, isEscapeKey, isUpKey } from "../utils/key-utils";
import { extractCodeBlocks } from "../utils/markdown-code";
import { truncateInline } from "../utils/text-utils";
import { listWorkspaceFiles } from "../utils/workspace-files";
import { Badge } from "../ui/components/badge";

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

function hasProposedPlanBlock(message: UIMessage): boolean {
  return containsProposedPlanBlock(collectMessageText(message));
}

// Matches textual tool-call blocks (any dialect the middleware understands) like:
// <tool_call>{"name":"read_file","parameters":{...}}</tool_call>
// <function_call>{"name":"bash","arguments":{...}}</function_call>
// <invoke name="read_file">, <function=bash>, DeepSeek <｜tool▁call▁begin｜> markers
const TOOL_CALL_XML_RE =
  /<(?:tool_call|function_call)>|<invoke\s+name=|<function=[\w.-]+>|<｜tool▁call(?:s)?▁begin｜>/i;

function hasToolCallXmlLeak(message: UIMessage): boolean {
  // Reset regex state to ensure consistent matching
  TOOL_CALL_XML_RE.lastIndex = 0;
  return TOOL_CALL_XML_RE.test(collectMessageText(message));
}

/**
 * Synthetic loop messages (auto-continue, nudges, stall retries) stay in
 * history for the model but are never rendered — limit handling is internal.
 */
function isAutoContinueMessage(message: UIMessage): boolean {
  return (
    message.role === "user" &&
    typeof message.metadata === "object" &&
    message.metadata !== null &&
    Reflect.get(message.metadata, "autoContinue") === true
  );
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
    requestedChatActionId,
    clearRequestedChatAction,
    changesPanelOpen,
    setChangesPanelOpen,
    toggleChangesPanel,
    setEditorActive,
    setChatFooterStatus,
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

    setContextState(parsedPayload.data.contextState ?? null);

    const persistedSession = parsedPayload.data.session;
    if (persistedSession) {
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
    autoContinueState,
    messages,
    pendingApprovals,
    pendingUserPrompts,
    canRetryRecoverableResponse,
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
    loadPersistedInteractions,
    upsertInteraction,
    resolveInteraction,
    sessionId,
    skipHistoryLoad,
    cwd: process.cwd(),
    mode,
    permissionMode,
    autoContinue: autoContinueConfig,
  });

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
        const files = await listWorkspaceFiles(process.cwd());
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
  }, []);

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

  // IDE layout (Explorer | Editor | Chat). The three panes need a wide terminal;
  // below this width the IDE is suppressed and the chat fills the screen.
  const MIN_WIDTH_FOR_PANEL = 100;
  const { width: terminalWidth } = useTerminalDimensions();
  const panelFitsTerminal = terminalWidth >= MIN_WIDTH_FOR_PANEL;
  const panelVisible = changesPanelOpen && panelFitsTerminal;

  // Real git working-tree changes drive the Changes tab + the tree markers.
  const gitChanges = useGitChanges({ cwd: process.cwd(), enabled: panelVisible });
  const changesFiles = gitChanges.files;
  const changedByPath = useMemo(() => {
    const map = new Map<string, ChangedFileChangeKind>();
    for (const file of changesFiles) {
      map.set(file.path, file.changeKind);
    }
    return map;
  }, [changesFiles]);
  // Files the agent edited this session — used only for a small "agent" badge.
  const agentChangedFiles = useChangedFiles(messages);
  const agentTouched = useMemo(
    () => new Set(agentChangedFiles.map((file) => file.path)),
    [agentChangedFiles],
  );

  // Changes-panel selection + focus. Selection is lifted here (not in the panel)
  // so the keyboard handler can drive it; the panel is presentational.
  const [selectedChangedPath, setSelectedChangedPath] = useState<string | null>(null);
  const [changedSelectionPinned, setChangedSelectionPinned] = useState(false);
  const [panelFocused, setPanelFocused] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("files");
  const [fileView, setFileView] = useState<FileViewMode>("content");
  // "browse" = read-only viewer; "edit" = the file is open in the editable buffer.
  const [panelMode, setPanelMode] = useState<"browse" | "edit">("browse");
  const [fileReloadToken, setFileReloadToken] = useState(0);

  // Editor-style project file tree (Files tab) + open-file tabs.
  const fileTree = useFileTree({
    cwd: process.cwd(),
    enabled: panelVisible && panelTab === "files",
  });
  // Open editor tabs (like an IDE). `activeFilePath` is the one shown.
  const MAX_OPEN_TABS = 8;
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const openFileContent = useFileContent(
    activeFilePath,
    process.cwd(),
    fileReloadToken,
  );

  const isEditingFile = panelMode === "edit";

  const openFileTab = useCallback((path: string) => {
    setOpenFiles((current) =>
      current.includes(path) ? current : [...current, path].slice(-MAX_OPEN_TABS),
    );
    setActiveFilePath(path);
  }, []);

  // Selecting a file in the tree opens (or focuses) its tab.
  useEffect(() => {
    if (fileTree.openFilePath) {
      openFileTab(fileTree.openFilePath);
    }
  }, [fileTree.openFilePath, openFileTab]);

  const selectFileTab = useCallback((path: string) => {
    setPanelMode("browse");
    setActiveFilePath(path);
  }, []);

  const closeFileTab = useCallback((path: string) => {
    setPanelMode("browse");
    setOpenFiles((current) => {
      const index = current.indexOf(path);
      if (index === -1) {
        return current;
      }
      const next = current.filter((file) => file !== path);
      setActiveFilePath((active) => {
        if (active !== path) {
          return active;
        }
        // Activate the nearest remaining tab.
        return next[index] ?? next[index - 1] ?? null;
      });
      return next;
    });
  }, []);

  const switchTab = useCallback(
    (delta: number) => {
      setActiveFilePath((current) => {
        if (openFiles.length === 0) {
          return current;
        }
        const index = current ? openFiles.indexOf(current) : -1;
        const base = index === -1 ? 0 : index;
        const nextIndex = (base + delta + openFiles.length) % openFiles.length;
        return openFiles[nextIndex] ?? current;
      });
    },
    [openFiles],
  );

  // Keep the global key handler in sync so it yields to the focused editor.
  useEffect(() => {
    setEditorActive(isEditingFile);
    return () => setEditorActive(false);
  }, [isEditingFile, setEditorActive]);

  // Leave edit mode automatically when the panel hides, the tab changes, or no
  // file is active.
  useEffect(() => {
    if (!panelVisible || panelTab !== "files" || !activeFilePath) {
      setPanelMode("browse");
    }
  }, [panelVisible, panelTab, activeFilePath]);

  const exitFileEdit = useCallback(() => setPanelMode("browse"), []);
  const enterFileEdit = useCallback(() => {
    const content = openFileContent;
    if (
      activeFilePath &&
      content.path === activeFilePath &&
      !content.loading &&
      !content.error
    ) {
      setPanelMode("edit");
    }
  }, [activeFilePath, openFileContent]);
  const handleFileSaved = useCallback(() => {
    // Re-read the file so the read-only view reflects the saved content, and
    // refresh git so the new change appears in the Changes tab / tree markers.
    setFileReloadToken((token) => token + 1);
    gitChanges.refresh();
  }, [gitChanges]);

  // Auto-refresh git changes when the assistant finishes a turn (it likely
  // edited files). Separate from the context-state refresh effect so it sits
  // after gitChanges is declared.
  const wasStreamingForGitRef = useRef(false);
  useEffect(() => {
    if (wasStreamingForGitRef.current && !isStreaming && panelVisible) {
      gitChanges.refresh();
    }
    wasStreamingForGitRef.current = isStreaming;
  }, [isStreaming, panelVisible, gitChanges]);

  const toggleFileView = useCallback(() => {
    setFileView((view) => (view === "content" ? "diff" : "content"));
  }, []);

  // When the active file changes, default the editor view: changed files open
  // straight to their git diff (git-GUI style), everything else to content.
  const activeFilePathRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeFilePath !== activeFilePathRef.current) {
      activeFilePathRef.current = activeFilePath;
      const isChangedFile =
        activeFilePath !== null &&
        changesFiles.some((file) => file.path === activeFilePath);
      setFileView(isChangedFile ? "diff" : "content");
    }
  }, [activeFilePath, changesFiles]);

  // Default-select the first changed file when nothing valid is selected yet
  // (unless the user pinned a selection).
  useEffect(() => {
    if (changedSelectionPinned || changesFiles.length === 0) {
      return;
    }
    setSelectedChangedPath((current) => {
      if (current && changesFiles.some((file) => file.path === current)) {
        return current;
      }
      return changesFiles[0]!.path;
    });
  }, [changedSelectionPinned, changesFiles]);

  // Lazily load the git diff for whatever file is in focus (Changes selection or
  // the file open in the Files tab).
  useEffect(() => {
    if (selectedChangedPath) {
      gitChanges.requestDiff(selectedChangedPath);
    }
  }, [selectedChangedPath, gitChanges]);
  useEffect(() => {
    if (activeFilePath) {
      gitChanges.requestDiff(activeFilePath);
    }
  }, [activeFilePath, gitChanges]);

  // Drop focus (and any pin) whenever the panel is hidden so reopening starts
  // clean and the input regains focus.
  useEffect(() => {
    if (!panelVisible) {
      setPanelFocused(false);
    }
  }, [panelVisible]);

  const selectChangedPath = useCallback((path: string) => {
    setSelectedChangedPath(path);
    setChangedSelectionPinned(true);
  }, []);

  // From the IDE sidebar: selecting a changed file also opens it in the center
  // editor pane, where its full-width diff renders (git-GUI style).
  const openChangedFile = useCallback(
    (path: string) => {
      selectChangedPath(path);
      openFileTab(path);
    },
    [selectChangedPath, openFileTab],
  );

  const moveChangedSelection = useCallback(
    (delta: number) => {
      if (changesFiles.length === 0) {
        return;
      }
      setSelectedChangedPath((current) => {
        const index = changesFiles.findIndex((file) => file.path === current);
        if (index === -1) {
          return changesFiles[0]!.path;
        }
        const nextIndex = Math.min(
          changesFiles.length - 1,
          Math.max(0, index + delta),
        );
        return changesFiles[nextIndex]!.path;
      });
      setChangedSelectionPinned(true);
    },
    [changesFiles],
  );

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
      });
    },
    [messages, notifyChatAction, renderer, sessionId],
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
        const expandedText = await appendMentionAttachments(text, process.cwd());
        submitInput(expandedText, files);
      })();
    },
    [closeSlashMenu, navigateIfSlashRoute, runChatSlashAction, submitInput],
  );

  const modeDefinition = codingAgentModes[mode];
  const contextEstimate = estimateContextUsage(messages, contextWindow);
  // Session $ from per-model pricing; null (hidden) when pricing is unknown.
  const sessionCostUsd = useMemo(
    () => computeSessionCostUsd(messages, pricing),
    [messages, pricing],
  );
  const contextMeterColor =
    contextEstimate.level === "critical"
      ? cliTheme.semantic.error
      : contextEstimate.level === "warning"
        ? cliTheme.semantic.warning
        : cliTheme.text.muted;
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

    // While the panel holds focus it owns navigation; the text area is blurred,
    // so swallow keys here to keep them out of the transcript.
    if (panelFocused && panelVisible) {
      const isTab = keyName === "tab" || keyEvent.sequence === "\t";
      const isRight = keyName === "right" || keyName === "l";
      const isLeft = keyName === "left" || keyName === "h";

      // Esc leaves the panel; Tab cycles between the Files and Changes tabs.
      if (isEscapeKey(keyName)) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        setPanelFocused(false);
        return;
      }
      if (isTab) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        setPanelTab((tab) => (tab === "files" ? "changes" : "files"));
        return;
      }

      if (panelTab === "files") {
        if (isUpKey(keyName, { vim: true })) {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          fileTree.moveSelection(-1);
          return;
        }
        if (isDownKey(keyName, { vim: true })) {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          fileTree.moveSelection(1);
          return;
        }
        if (isRight) {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          fileTree.expandOrEnter();
          return;
        }
        if (isLeft) {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          fileTree.collapseOrParent();
          return;
        }
        if (isEnterKey(keyName)) {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          fileTree.activateSelected();
          return;
        }
        if (keyName === "d") {
          // Toggle between the file's contents and its diff (changed files).
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          toggleFileView();
          return;
        }
        if (keyName === "e") {
          // Edit the active file in place (no-op for dirs / unloaded / binary).
          const content = openFileContent;
          const editable =
            activeFilePath !== null &&
            content.path === activeFilePath &&
            !content.loading &&
            !content.error;
          if (editable) {
            keyEvent.preventDefault();
            keyEvent.stopPropagation();
            setPanelMode("edit");
          }
          return;
        }
        // [ and ] cycle between open editor tabs.
        if (keyName === "[" || keyEvent.sequence === "[") {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          switchTab(-1);
          return;
        }
        if (keyName === "]" || keyEvent.sequence === "]") {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          switchTab(1);
          return;
        }
        if (keyName === "w" && !keyEvent.ctrl && activeFilePath) {
          // Close the active tab.
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          closeFileTab(activeFilePath);
          return;
        }
      } else {
        if (isUpKey(keyName, { vim: true })) {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          moveChangedSelection(-1);
          return;
        }
        if (isDownKey(keyName, { vim: true })) {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          moveChangedSelection(1);
          return;
        }
        if (isEnterKey(keyName)) {
          // Open the selected change in the center editor pane (full-width diff).
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          if (selectedChangedPath) {
            openChangedFile(selectedChangedPath);
          }
          return;
        }
        if (keyName === "r") {
          // Manual git refresh.
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          gitChanges.refresh();
          return;
        }
      }

      // Let F2 reach the global handler so it can still toggle visibility;
      // swallow everything else so it can't leak into the transcript.
      if (keyName === "f2") {
        return;
      }
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

  // Active-pane focus ring (IDE layout). Exactly one pane carries the amber
  // border at a time, derived from the existing focus/edit state.
  const editorFocused = isEditingFile;
  const explorerFocused = panelFocused && !isEditingFile;
  const chatFocused = panelVisible && !panelFocused && !isEditingFile;

  // Line count of the file shown in the editor — for the status bar (0 unless
  // the active file's content is loaded).
  const activeLineCount =
    activeFilePath &&
    openFileContent.path === activeFilePath &&
    !openFileContent.loading &&
    !openFileContent.error &&
    openFileContent.content
      ? openFileContent.content.split("\n").length
      : 0;

  const chatShell = (
      <ChatShell
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
          panelFitsTerminal && !panelVisible ? (
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
                    <text wrapMode="none" truncate fg={cliTheme.text.muted}>Copy: ↑/↓ select · Enter copy · c code · Esc exit</text>
                  ) : panelFocused ? (
                    <text wrapMode="none" truncate fg={cliTheme.text.muted}>
                      {panelTab === "files"
                        ? "↑/↓ · Enter open · e edit · Esc"
                        : "↑/↓ · Enter diff · r refresh · Esc"}
                    </text>
                  ) : panelVisible ? (
                    <text wrapMode="none" truncate fg={cliTheme.text.muted}>Enter send · Tab explorer · F2 exit</text>
                  ) : canRetryRecoverableResponse ? (
                    <text wrapMode="none" truncate fg={cliTheme.text.muted}>
                      {errorMessage && /rate.?limit/i.test(errorMessage)
                        ? "Rate-limited — wait a moment, /model to switch, or add provider credits"
                        : "Type retry or regenerate to try again"}
                    </text>
                  ) : pendingApprovals.length > 0 ? (
                    <text wrapMode="none" truncate fg={cliTheme.text.muted}>Enter approve · type deny to reject · or reply</text>
                  ) : hasBlockingPopup ? (
                    <text wrapMode="none" truncate fg={cliTheme.text.muted}>Complete the inline prompt to continue</text>
                  ) : slashMenuOpen ? (
                    <text wrapMode="none" truncate fg={cliTheme.text.muted}>↑/↓ select · Enter open · Esc close</text>
                  ) : (
                    <text wrapMode="none" truncate fg={cliTheme.text.muted}>Enter send · Ctrl+Enter newline</text>
                  )}
                </box>
                <box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
                  <text fg={contextMeterColor}>
                    {truncateInline(contextEstimate.displayText, 24)}
                  </text>
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

  const explorerSidebar = (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      borderStyle={borderStyleFor.card}
      borderColor={explorerFocused ? cliTheme.borders.active : cliTheme.borders.subtle}
      backgroundColor={cliTheme.surfaces.inset}
    >
      <box flexDirection="row" alignItems="center" flexShrink={0} gap={1} paddingX={1}>
        <TabButton label="Explorer" active={panelTab === "files"} onPress={() => setPanelTab("files")} />
        <TabButton
          label={`Changes${changesFiles.length > 0 ? ` ${changesFiles.length}` : ""}`}
          active={panelTab === "changes"}
          onPress={() => setPanelTab("changes")}
        />
      </box>
      <box flexGrow={1} flexDirection="column">
        {panelTab === "files" ? (
          <ExplorerTree tree={fileTree} changedByPath={changedByPath} rootPath={process.cwd()} />
        ) : (
          <ChangesTab
            changedFiles={changesFiles}
            selectedChangePath={selectedChangedPath}
            onSelectChange={openChangedFile}
            stickToNewest={!changedSelectionPinned}
            focused={panelFocused}
            branch={gitChanges.branch}
            ahead={gitChanges.ahead}
            behind={gitChanges.behind}
            loading={gitChanges.loading}
            isRepo={gitChanges.isRepo}
            agentTouched={agentTouched}
            listOnly
          />
        )}
      </box>
    </box>
  );

  const editorCenter = (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      borderStyle={borderStyleFor.card}
      borderColor={editorFocused ? cliTheme.borders.active : cliTheme.borders.subtle}
      backgroundColor={cliTheme.surfaces.inset}
    >
      <EditorPane
        openFiles={openFiles}
        activeFilePath={activeFilePath}
        changedFiles={changesFiles}
        fileContent={openFileContent}
        fileView={fileView}
        onToggleFileView={toggleFileView}
        editing={isEditingFile}
        cwd={process.cwd()}
        onExitEdit={exitFileEdit}
        onSavedEdit={handleFileSaved}
        notify={notifyChatAction}
        onSelectFileTab={selectFileTab}
        onCloseFileTab={closeFileTab}
        onEnterEdit={enterFileEdit}
      />
    </box>
  );

  return (
    <IdeLayout
      explorer={explorerSidebar}
      editor={editorCenter}
      chat={chatShell}
      onExitIde={() => setChangesPanelOpen(false)}
      branch={gitChanges.branch}
      ahead={gitChanges.ahead}
      behind={gitChanges.behind}
      activeFilePath={activeFilePath}
      modeLabel={modeDefinition.label}
      permissionMode={permissionMode}
      lineCount={activeLineCount}
    />
  );
}
