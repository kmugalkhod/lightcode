import { useEffect } from "react";
import type { SlashCommandDefinition } from "../lib/slash-command-registry";
import type { CommandResult } from "../lib/web-command-executor";
import { Icon, type IconName } from "./icons";

function categoryIcon(category: SlashCommandDefinition["category"]): IconName {
  if (category === "conversation") return "message";
  if (category === "configuration") return "settings";
  if (category === "diagnostics") return "tool";
  return "terminal";
}

export function SlashCommandMenu({
  id,
  commands,
  selectedIndex,
  onSelect,
  onRun,
}: {
  id: string;
  commands: readonly SlashCommandDefinition[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onRun: (command: SlashCommandDefinition) => void;
}) {
  const selectedCommand = commands[selectedIndex];
  useEffect(() => {
    if (!selectedCommand) return;
    document
      .getElementById(`${id}-option-${selectedCommand.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [id, selectedCommand]);

  return (
    <section className="slash-command-menu" aria-label="Slash commands">
      <div className="slash-command-menu-header">
        <span>Commands</span>
        <span><kbd>↑↓</kbd> move <kbd>Tab</kbd> complete <kbd>↵</kbd> run</span>
      </div>
      <div className="slash-command-options" id={id} role="listbox">
        {commands.length ? commands.map((command, index) => (
          <button
            className={index === selectedIndex ? "slash-command-option selected" : "slash-command-option"}
            id={`${id}-option-${command.id}`}
            key={command.id}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            onPointerEnter={() => onSelect(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onRun(command)}
          >
            <span className="slash-command-icon"><Icon name={categoryIcon(command.category)} size={15} /></span>
            <span className="slash-command-copy">
              <span>
                <code>{command.command}</code>
                {command.argumentHint ? <small>{command.argumentHint}</small> : null}
              </span>
              <small>{command.description}</small>
            </span>
            <span className="slash-command-enter">↵</span>
          </button>
        )) : (
          <div className="slash-command-empty" role="status">
            No matching command. Try <code>/help</code>.
          </div>
        )}
      </div>
    </section>
  );
}

export function CommandResultPanel({
  result,
  busy,
  onDismiss,
}: {
  result: CommandResult | null;
  busy?: string | null;
  onDismiss: () => void;
}) {
  if (busy) {
    return (
      <div className="command-result tone-info" role="status" aria-live="polite">
        <span className="command-result-icon"><span className="button-loading" /></span>
        <div><strong>Running /{busy}</strong><p>Lightcode is checking the local server.</p></div>
      </div>
    );
  }
  if (!result) return null;
  return (
    <div className={`command-result tone-${result.tone}`} role={result.tone === "error" ? "alert" : "status"} aria-live="polite">
      <span className="command-result-icon">
        <Icon name={result.tone === "error" ? "warning" : result.tone === "success" ? "check" : "terminal"} size={15} />
      </span>
      <div><strong>{result.title}</strong><p>{result.detail}</p></div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss command result"><Icon name="x" size={14} /></button>
    </div>
  );
}

export function commandOptionId(
  menuId: string,
  command: SlashCommandDefinition | undefined,
): string | undefined {
  return command ? `${menuId}-option-${command.id}` : undefined;
}

export function completeSlashCommand(command: SlashCommandDefinition): string {
  return command.argumentHint ? `${command.command} ` : command.command;
}
