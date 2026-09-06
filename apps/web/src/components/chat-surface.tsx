import type { PendingToolApproval, PendingUserPrompt } from "@lightcode/ai/react";
import { useCodingSessionChat } from "@lightcode/ai/react";
import { useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import type {
  CodingMode,
  LightcodeApi,
  PermissionMode,
  ProviderStatus,
  Session,
  Workspace,
} from "../lib/api";
import type { SlashCommandDefinition } from "../lib/slash-command-registry";
import {
  executeWebCommand,
  type CommandResult,
} from "../lib/web-command-executor";
import { ChatMessage } from "./chat-message";
import { CommandComposer } from "./command-composer";
import { Icon } from "./icons";
import { displaySessionTitle } from "../lib/api";

interface ChatSurfaceProps {
  api: LightcodeApi;
  token: string;
  session: Session;
  workspace: Workspace | null;
  mode: CodingMode;
  permissionMode: PermissionMode;
  providerStatus: ProviderStatus | null;
  sessions: Session[];
  initialPrompt?: string;
  onRunStateChange: (running: boolean) => void;
  onSessionUpdated: () => void;
  onNewSession: () => void;
  onOpenSessions: () => void;
  onSelectSession: (session: Session) => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
  onProviderStatusChange: (status: ProviderStatus) => void;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function ChatSurface({
  api,
  token,
  session,
  workspace,
  mode,
  permissionMode,
  providerStatus,
  sessions,
  initialPrompt,
  onRunStateChange,
  onSessionUpdated,
  onNewSession,
  onOpenSessions,
  onSelectSession,
  onPermissionModeChange,
  onProviderStatusChange,
}: ChatSurfaceProps) {
  const chat = useCodingSessionChat({
    chatApi: `/sessions/${encodeURIComponent(session.id)}/turns`,
    sessionId: session.id,
    isSessionIdValid: uuidPattern.test(session.id),
    cwd: session.cwd ?? session.pathLabel ?? workspace?.pathLabel ?? ".",
    mode,
    permissionMode,
    initialPrompt,
    fetch: api.fetch,
    headers: () => ({ Authorization: `Bearer ${token}` }),
    loadPersistedMessages: async () => {
      const payload = await api.loadSession(session.id);
      return { session: payload.session, messages: payload.messages };
    },
    loadPersistedInteractions: () => api.listPendingInteractions(session.id),
    upsertInteraction: (interaction) => api.checkpointInteraction(session.id, interaction),
    resolveInteraction: (toolCallId, resolution) =>
      api.resolveInteraction(session.id, toolCallId, resolution),
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const followOutputRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const previousStreamingRef = useRef(false);
  const [commandResult, setCommandResult] = useState<CommandResult | null>(null);
  const [commandBusy, setCommandBusy] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    onRunStateChange(chat.isStreaming);
    if (previousStreamingRef.current && !chat.isStreaming) {
      onSessionUpdated();
    }
    previousStreamingRef.current = chat.isStreaming;
  }, [chat.isStreaming, onRunStateChange, onSessionUpdated]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !followOutputRef.current) return;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (followOutputRef.current) {
        element.scrollTop = element.scrollHeight;
      }
    });
  }, [chat.isStreaming, chat.messages]);

  useEffect(() => {
    const element = scrollRef.current;
    const content = element?.firstElementChild;
    if (!element || !content) return;
    const observer = new ResizeObserver(() => {
      if (!followOutputRef.current || scrollFrameRef.current !== null) return;
      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        if (followOutputRef.current) element.scrollTop = element.scrollHeight;
      });
    });
    observer.observe(content);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, []);

  function handleScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const movedUp = element.scrollTop < lastScrollTopRef.current - 1;
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    lastScrollTopRef.current = element.scrollTop;
    if (movedUp && remaining > 2) {
      followOutputRef.current = false;
      setFollowing(false);
      return;
    }
    if (scrollFrameRef.current !== null && followOutputRef.current) return;
    followOutputRef.current = remaining < 140;
    setFollowing(followOutputRef.current);
  }

  async function runCommand(
    command: SlashCommandDefinition,
    args: string,
    available: boolean,
  ) {
    if (!available) {
      setCommandResult({
        title: `${command.command} needs a session`,
        detail: "Start or open a session, then run the command again.",
        tone: "error",
      });
      return;
    }
    setCommandResult(null);
    setCommandBusy(command.id);
    const next = await executeWebCommand(command.id, args, {
      api,
      sessionId: session.id,
      messages: chat.messages as UIMessage[],
      sessions,
      mode,
      permissionMode,
      providerStatus,
      isStreaming: chat.isStreaming,
      abortActiveRun: chat.abortActiveRun,
      refreshMessages: chat.refreshPersistedMessages,
      onSessionUpdated,
      onNewSession,
      onOpenSessions,
      onSelectSession,
      onPermissionModeChange,
      onProviderStatusChange,
    });
    setCommandBusy(null);
    setCommandResult(next);
  }

  return (
    <section className="chat-surface" aria-label="Project conversation">
      <header className="conversation-heading"><div><h1>{displaySessionTitle(session)}</h1><span>{mode === "plan" ? "Planning" : "Building"} · {chat.messages.filter((message) => message.role === "user").length} messages from you</span></div><span className={chat.isStreaming ? "conversation-state running" : "conversation-state"}><span className="live-dot" />{chat.pendingApprovals.length || chat.pendingUserPrompts.length ? "Your input needed" : chat.isStreaming ? "Working" : "Ready for your next step"}</span></header>
      <div className="conversation-scroll" ref={scrollRef} onScroll={handleScroll}>
        <div className="conversation-column">
          {chat.isHistoryLoading ? <ConversationSkeleton /> : null}
          {!chat.isHistoryLoading && chat.messages.length === 0 ? (
            <div className="conversation-empty">
              <span className="empty-mark"><Icon name="lightcode" size={24} /></span>
              <h1>Start with the project in front of you.</h1>
              <p>Ask Lightcode to trace behavior, plan a change, fix an issue, or verify the work.</p>
            </div>
          ) : null}
          {chat.messages.map((message) => (
            <ChatMessage key={message.id} message={message as UIMessage} />
          ))}
          {chat.isStreaming ? (
            <div className="agent-working" role="status">
              <span className="live-dot" />
              Lightcode is working
            </div>
          ) : null}
        </div>
      </div>

      <div className="conversation-controls">
        <div className="conversation-column">
          {!following ? <button className="jump-to-latest" type="button" onClick={() => { followOutputRef.current = true; setFollowing(true); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }}><Icon name="chevron-down" size={16} />Back to latest{chat.isStreaming ? " · Live" : ""}</button> : null}
          {chat.errorMessage ? (
            <div className="inline-error" role="alert">
              <Icon name="warning" size={17} />
              <span>{chat.errorMessage}</span>
              {chat.canRetryRecoverableResponse ? (
                <button type="button" onClick={() => void chat.retryRecoverableResponse()}>Retry</button>
              ) : null}
            </div>
          ) : null}

          {chat.pendingApprovals.length > 0 ? (
            <ApprovalDock approvals={chat.pendingApprovals} onResolve={chat.resolveToolApproval} />
          ) : null}

          {chat.pendingUserPrompts.map((prompt) => (
            <PromptDock key={prompt.toolCallId} prompt={prompt} onRespond={chat.respondToUserPrompt} />
          ))}

          <CommandComposer
            draftKey={session.id}
            appearance="conversation"
            hasSession
            canSendMessage={!chat.isLoading && chat.pendingApprovals.length === 0 && chat.pendingUserPrompts.length === 0}
            isStreaming={chat.isStreaming}
            placeholder={chat.pendingApprovals.length > 0 || chat.pendingUserPrompts.length > 0 ? "Resolve the active step, or type / for commands" : "What are you building? Type / for commands"}
            commandResult={commandResult}
            commandBusy={commandBusy}
            onDismissResult={() => setCommandResult(null)}
            onAbort={() => void chat.abortActiveRun()}
            onSubmit={(text) => {
              setCommandResult(null);
              chat.submitInput(text);
            }}
            onCommand={(command, args, available) => void runCommand(command, args, available)}
            onUnknownCommand={(invokedAs) => setCommandResult({
              title: `Unknown command ${invokedAs}`,
              detail: "Type / to see every available command.",
              tone: "error",
            })}
          />
          <div className="composer-hint">
            <span>Enter to send · Shift+Enter for a new line</span>
            <span>{mode === "plan" ? "Plan mode · Read only" : permissionMode === "workspace-write" ? "Build mode · Project access" : permissionMode === "danger-full-access" ? "Build mode · Full access" : "Build mode · Read only"}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function ApprovalDock({
  approvals,
  onResolve,
}: {
  approvals: PendingToolApproval[];
  onResolve: (action: "approve" | "deny", index: number) => void;
}) {
  return (
    <section className="approval-dock" aria-label="Tool approvals">
      {approvals.map((approval, index) => (
        <div className="approval-row" key={approval.toolCallId}>
          <span className="approval-icon"><Icon name="shield" size={17} /></span>
          <div>
            <strong>Approval required</strong>
            <p>{approval.summary}</p>
            <small>{approval.permissionDecision.reason ?? `${approval.toolName.replaceAll("_", " ")} needs ${approval.permissionDecision.requiredMode}.`}</small>
          </div>
          <div className="approval-actions">
            <button className="secondary-button" type="button" onClick={() => onResolve("deny", index)}>Deny</button>
            <button className="primary-button compact-primary" type="button" onClick={() => onResolve("approve", index)}>Approve once</button>
          </div>
        </div>
      ))}
    </section>
  );
}

function PromptDock({
  prompt,
  onRespond,
}: {
  prompt: PendingUserPrompt;
  onRespond: (response: { toolCallId: string; answer: string; source: "option" | "custom" }) => void;
}) {
  const [customAnswer, setCustomAnswer] = useState("");
  return (
    <section className="prompt-dock" aria-label="Question from Lightcode">
      <div>
        <strong>{prompt.header ?? "Lightcode needs your input"}</strong>
        <p>{prompt.question}</p>
      </div>
      <div className="prompt-options">
        {prompt.options.map((option) => (
          <button
            className="secondary-button"
            type="button"
            key={option.label}
            title={option.description}
            onClick={() => onRespond({ toolCallId: prompt.toolCallId, answer: option.label, source: "option" })}
          >
            {option.label}
          </button>
        ))}
      </div>
      {prompt.allowCustomResponse ? (
        <form
          className="prompt-custom"
          onSubmit={(event) => {
            event.preventDefault();
            if (!customAnswer.trim()) return;
            onRespond({ toolCallId: prompt.toolCallId, answer: customAnswer.trim(), source: "custom" });
          }}
        >
          <input aria-label="Your answer" value={customAnswer} onChange={(event) => setCustomAnswer(event.currentTarget.value)} placeholder={prompt.placeholder ?? "Type a response"} />
          <button className="primary-button compact-primary" type="submit" disabled={!customAnswer.trim()}>Reply</button>
        </form>
      ) : null}
    </section>
  );
}

function ConversationSkeleton() {
  return (
    <div className="conversation-skeleton" aria-label="Loading conversation">
      <span /><span /><span /><span />
    </div>
  );
}
