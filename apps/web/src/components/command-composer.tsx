import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
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
  onSubmit: (text: string) => void;
  onCommand: (command: SlashCommandDefinition, args: string, available: boolean) => void;
  onUnknownCommand: (invokedAs: string) => void;
}) {
  const [value, setValue] = useState("");
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
  const canRunValue = value.trim().length > 0 && (slashInput || canSendMessage) && !commandBusy;

  useEffect(() => {
    if (selectedIndex !== safeSelectedIndex) setSelectedIndex(safeSelectedIndex);
  }, [safeSelectedIndex, selectedIndex]);

  function clearAfterCommand() {
    setValue("");
    setSelectedIndex(0);
    setMenuDismissed(false);
  }

  function runCommand(command: SlashCommandDefinition, args = "", available = true) {
    onCommand(command, args, available);
    clearAfterCommand();
  }

  function send() {
    const message = value.trim();
    if (!message || commandBusy) return;
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
    onSubmit(message);
    setValue("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen && event.key === "Escape") {
      event.preventDefault();
      setMenuDismissed(true);
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
      send();
    }
  }

  return (
    <div className={`command-composer-shell appearance-${appearance}`}>
      <CommandResultPanel result={commandResult} busy={commandBusy} onDismiss={onDismissResult} />
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
          <span><Icon name="agent" size={16} />Agent <small>type / for commands</small></span>
          {isStreaming && onAbort ? (
            <button className="abort-button" type="button" onClick={onAbort}>
              <Icon name="abort" size={14} />Stop run
            </button>
          ) : (
            <button className="send-button" type="button" onClick={send} disabled={!canRunValue} aria-label={slashInput ? "Run command" : "Send message"}>
              {commandBusy ? <span className="button-loading" /> : <Icon name={slashInput ? "terminal" : "arrow-up"} size={17} />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
