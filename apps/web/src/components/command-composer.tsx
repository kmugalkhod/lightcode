import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { readComposerDraft, saveComposerDraft } from "../lib/composer-draft";
import {
  getSlashCommandSuggestions,
  parseSlashCommand,
  type SlashCommandDefinition,
} from "../lib/slash-command-registry";
import type { CommandResult } from "../lib/web-command-executor";
import {
  CommandResultPanel,
  SlashCommandMenu,
  commandOptionId,
  completeSlashCommand,
} from "./slash-command-menu";
import { Icon } from "./icons";

export interface ComposerSessionInfo {
  title: string;
  mode: string;
  permission: string;
  messageCount: number;
  status: "Ready" | "Working" | "Input needed" | "Loading" | "Error";
}

export function CommandComposer({
  appearance,
  hasSession,
  canSendMessage,
  isStreaming = false,
  autoFocus = false,
  placeholder,
  commandResult,
  commandBusy,
  onDismissResult,
  onAbort,
  onSubmit,
  onCommand,
  onUnknownCommand,
  draftKey,
  suggestedDraft,
  sessionInfo,
}: {
  appearance: "conversation" | "starter";
  hasSession: boolean;
  canSendMessage: boolean;
  isStreaming?: boolean;
  autoFocus?: boolean;
  placeholder: string;
  commandResult: CommandResult | null;
  commandBusy: string | null;
  onDismissResult: () => void;
  onAbort?: () => void;
  onSubmit: (text: string) => void | boolean | Promise<void | boolean>;
  draftKey?: string;
  suggestedDraft?: { text: string; id: number } | null;
  sessionInfo?: ComposerSessionInfo;
  onCommand: (command: SlashCommandDefinition, args: string, available: boolean) => void;
  onUnknownCommand: (invokedAs: string) => void;
}) {
  const [value, setValue] = useState(() => draftKey ? readComposerDraft(draftKey) : "");
  const [submitting, setSubmitting] = useState(false);
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const sessionButtonRef = useRef<HTMLButtonElement>(null);
  const sessionPanelId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submitLock = useRef(false);
  const draftBeforeCommands = useRef<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const menuId = `slash-menu-${useId().replaceAll(":", "")}`;
  const slashInput = value.trimStart().startsWith("/") && !value.includes("\n");
  const suggestions = useMemo(
    () => slashInput
      ? getSlashCommandSuggestions(value, { hasSession })
      : [],
    [hasSession, slashInput, value],
  );
  const menuOpen = slashInput && !menuDismissed;
  const safeSelectedIndex = Math.min(selectedIndex, Math.max(0, suggestions.length - 1));
  const selectedCommand = suggestions[safeSelectedIndex];
  const parsed = parseSlashCommand(value, { hasSession });
  const canRunValue = value.trim().length > 0 && (slashInput || canSendMessage) && !commandBusy && !submitting;

  useEffect(() => {
    if (!sessionInfoOpen) return;
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !shellRef.current?.contains(event.target)) setSessionInfoOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [sessionInfoOpen]);

  useEffect(() => {
    if (draftKey) saveComposerDraft(draftKey, draftBeforeCommands.current ?? value);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
    }
  }, [value, draftKey]);

  useEffect(() => {
    if (!suggestedDraft) return;
    setValue(suggestedDraft.text);
    textareaRef.current?.focus();
  }, [suggestedDraft]);

  useEffect(() => {
    if (selectedIndex !== safeSelectedIndex) setSelectedIndex(safeSelectedIndex);
  }, [safeSelectedIndex, selectedIndex]);

  function clearAfterCommand() {
    setValue(draftBeforeCommands.current ?? "");
    draftBeforeCommands.current = null;
    setSelectedIndex(0);
    setMenuDismissed(false);
  }

  function runCommand(command: SlashCommandDefinition, args = "", available = true) {
    onCommand(command, args, available);
    clearAfterCommand();
  }

  async function send() {
    const message = value.trim();
    if (!message || commandBusy || submitLock.current) return;
    if (parsed.kind === "command") {
      runCommand(parsed.command, parsed.args, parsed.available);
      return;
    }
    if (parsed.kind === "unknown" || parsed.kind === "incomplete") {
      if (menuOpen && selectedCommand) {
        runCommand(selectedCommand);
      } else {
        onUnknownCommand(parsed.kind === "unknown" ? parsed.invokedAs : message);
        clearAfterCommand();
      }
      return;
    }
    if (!canSendMessage) return;
    submitLock.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await onSubmit(message);
      if (result !== false) {
        if (draftKey && readComposerDraft(draftKey).trim() === message) saveComposerDraft(draftKey, "");
        setValue((current) => current.trim() === message ? "" : current);
      }
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "Message could not be sent. Your draft is still here.");
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen && event.key === "Escape") {
      event.preventDefault();
      setMenuDismissed(true);
      if (draftBeforeCommands.current !== null) clearAfterCommand();
      return;
    }
    if (menuOpen && suggestions.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setSelectedIndex((current) => (current + delta + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Tab" && selectedCommand) {
        event.preventDefault();
        setValue(completeSlashCommand(selectedCommand));
        setSelectedIndex(0);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <div ref={shellRef} className={`command-composer-shell appearance-${appearance}`}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setSessionInfoOpen(false); }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && sessionInfoOpen) {
          event.preventDefault();
          event.stopPropagation();
          setSessionInfoOpen(false);
          sessionButtonRef.current?.focus();
        }
      }}>
      {sessionInfo && sessionInfoOpen ? <section className="composer-session-panel" id={sessionPanelId} aria-label="Session details">
        <h2>{sessionInfo.title}</h2>
        <p>{sessionInfo.mode} · {sessionInfo.permission}</p>
        <p>{sessionInfo.messageCount} {sessionInfo.messageCount === 1 ? "message" : "messages"} from you · {sessionInfo.status}</p>
      </section> : null}
      <CommandResultPanel result={commandResult} busy={commandBusy} onDismiss={onDismissResult} />
      {submitError ? <p className="new-session-error" role="alert">{submitError}</p> : null}
      {menuOpen ? (
        <SlashCommandMenu
          id={menuId}
          commands={suggestions}
          selectedIndex={safeSelectedIndex}
          onSelect={setSelectedIndex}
          onRun={(command) => {
            const args = parsed.kind === "command" && parsed.command.id === command.id ? parsed.args : "";
            runCommand(command, args, hasSession || command.availability === "always");
          }}
        />
      ) : null}
      <div className={appearance === "starter" ? "starter-composer" : canSendMessage || slashInput ? "composer" : "composer disabled"}>
        <textarea
          ref={textareaRef}
          value={value}
          rows={appearance === "starter" ? 3 : 1}
          autoFocus={autoFocus}
          aria-label={appearance === "starter" ? "First message or slash command" : "Message or slash command"}
          aria-autocomplete="list"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          aria-activedescendant={menuOpen ? commandOptionId(menuId, selectedCommand) : undefined}
          placeholder={placeholder}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setSelectedIndex(0);
            setMenuDismissed(false);
            if (commandResult) onDismissResult();
          }}
          onKeyDown={handleKeyDown}
        />
        <div className={appearance === "starter" ? "starter-toolbar" : "composer-toolbar"}>
          <button className="composer-command-trigger" type="button" onClick={() => { setSessionInfoOpen(false); if (!slashInput) draftBeforeCommands.current = value; setValue("/"); setMenuDismissed(false); textareaRef.current?.focus(); }} title="Browse slash commands">
            <Icon name="terminal" size={16} />Commands <kbd>/</kbd>
          </button>
          {sessionInfo ? <div className="composer-session-context">
            <button ref={sessionButtonRef} className="composer-session-trigger" type="button"
              aria-label={`Session details: ${sessionInfo.title}`} aria-expanded={sessionInfoOpen}
              aria-controls={sessionInfoOpen ? sessionPanelId : undefined}
              title={sessionInfo.title} onClick={() => { setMenuDismissed(true); setSessionInfoOpen((open) => !open); }}>
              <Icon name="message" size={15} /><span>Session</span><Icon name="chevron-down" size={12} />
            </button>
            <span className={`composer-session-status status-${sessionInfo.status.toLowerCase().replaceAll(" ", "-")}`} role="status">{sessionInfo.status}</span>
          </div> : <span className="draft-status">{submitting ? "Sending…" : value && !slashInput ? "Enter to send" : ""}</span>}
          {isStreaming && onAbort ? (
            <button className="abort-button" type="button" onClick={onAbort}>
              <Icon name="abort" size={14} />Stop run
            </button>
          ) : (
            <button className="send-button" type="button" onClick={() => void send()} disabled={!canRunValue} aria-label={slashInput ? "Run command" : "Send message"}>
              {commandBusy || submitting ? <span className="button-loading" /> : <Icon name={slashInput ? "terminal" : "arrow-up"} size={17} />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
