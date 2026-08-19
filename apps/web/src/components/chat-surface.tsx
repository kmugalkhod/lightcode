import type { PendingToolApproval, PendingUserPrompt } from "@lightcode/ai/react";
import { useCodingSessionChat } from "@lightcode/ai/react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { UIMessage } from "ai";
import type {
  CodingMode,
  LightcodeApi,
  PermissionMode,
  Session,
  Workspace,
} from "../lib/api";
import { ChatMessage } from "./chat-message";
import { Icon } from "./icons";

interface ChatSurfaceProps {
  api: LightcodeApi;
  token: string;
  session: Session;
  workspace: Workspace | null;
  mode: CodingMode;
  permissionMode: PermissionMode;
  initialPrompt?: string;
  onRunStateChange: (running: boolean) => void;
  onSessionUpdated: () => void;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function ChatSurface({
  api,
  token,
  session,
  workspace,
  mode,
  permissionMode,
  initialPrompt,
  onRunStateChange,
  onSessionUpdated,
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
  const followOutputRef = useRef(true);
  const previousStreamingRef = useRef(false);

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
    element.scrollTo({ top: element.scrollHeight, behavior: chat.isStreaming ? "auto" : "smooth" });
  }, [chat.isStreaming, chat.messages]);

  function handleScroll() {
    const element = scrollRef.current;
    if (!element) return;
    followOutputRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 140;
  }

  return (
    <section className="chat-surface" aria-label="Project conversation">
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

          <Composer
            disabled={chat.isLoading || chat.pendingApprovals.length > 0 || chat.pendingUserPrompts.length > 0}
            isStreaming={chat.isStreaming}
            onAbort={() => void chat.abortActiveRun()}
            onSubmit={chat.submitInput}
          />
          <div className="composer-hint">
            <span>Enter to send · Shift+Enter for a new line</span>
            <span>History is shared with the CLI</span>
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
          <input value={customAnswer} onChange={(event) => setCustomAnswer(event.currentTarget.value)} placeholder={prompt.placeholder ?? "Type a response"} />
          <button className="primary-button compact-primary" type="submit" disabled={!customAnswer.trim()}>Reply</button>
        </form>
      ) : null}
    </section>
  );
}

function Composer({
  disabled,
  isStreaming,
  onAbort,
  onSubmit,
}: {
  disabled: boolean;
  isStreaming: boolean;
  onAbort: () => void;
  onSubmit: (text: string) => void;
}) {
  const [value, setValue] = useState("");

  function send() {
    const message = value.trim();
    if (!message || disabled) return;
    onSubmit(message);
    setValue("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }

  return (
    <div className={disabled ? "composer disabled" : "composer"}>
      <textarea
        value={value}
        rows={1}
        disabled={disabled}
        aria-label="Message Lightcode"
        placeholder={disabled ? "Resolve the active step to continue" : "What are you building?"}
        onChange={(event) => {
          setValue(event.currentTarget.value);
        }}
        onKeyDown={handleKeyDown}
      />
      <div className="composer-toolbar">
        <span><Icon name="agent" size={16} />Agent</span>
        {isStreaming ? (
          <button className="abort-button" type="button" onClick={onAbort}>
            <Icon name="abort" size={14} />Stop run
          </button>
        ) : (
          <button className="send-button" type="button" onClick={send} disabled={!value.trim() || disabled} aria-label="Send message">
            <Icon name="arrow-up" size={17} />
          </button>
        )}
      </div>
    </div>
  );
}

function ConversationSkeleton() {
  return (
    <div className="conversation-skeleton" aria-label="Loading conversation">
      <span /><span /><span /><span />
    </div>
  );
}
