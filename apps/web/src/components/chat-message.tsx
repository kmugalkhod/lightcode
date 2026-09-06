import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { memo, useState } from "react";
import { MessageMarkdown } from "./message-markdown";
import { Icon } from "./icons";

interface ChatMessageProps {
  message: UIMessage;
}

function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function stringifyPreview(value: unknown, limit = 1_600) {
  if (typeof value === "string") return value.slice(0, limit);
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
  } catch {
    return "Output could not be displayed.";
  }
}

function toolTarget(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  for (const key of ["path", "command", "query", "pattern", "url", "description"]) {
    const value = Reflect.get(input, key);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function toolStateLabel(state: string) {
  if (state === "approval-requested") return "Approval needed";
  if (state === "approval-responded") return "Approval received";
  if (state === "output-available") return "Completed";
  if (state === "output-error") return "Failed";
  if (state === "output-denied") return "Denied";
  if (state === "input-streaming") return "Preparing";
  return "Running";
}

const ToolPart = memo(function ToolPart({ part }: { part: Extract<UIMessage["parts"][number], { toolCallId: string }> }) {
  const toolName = getToolName(part);
  const target = toolTarget(part.input);
  const state = part.state;
  const hasOutput = state === "output-available" || state === "output-error" || state === "output-denied";
  const output =
    state === "output-available"
      ? part.output
      : state === "output-error"
        ? part.errorText
        : state === "output-denied"
          ? part.approval.reason ?? "Tool execution was denied."
          : null;

  return (
    <details className={`tool-event state-${state}`} open={state === "approval-requested" || state === "output-error"}>
      <summary>
        <span className="tool-state-mark"><Icon name={state === "output-error" ? "warning" : state === "output-available" ? "check" : "terminal"} size={15} /></span>
        <span className="tool-summary-copy">
          <strong>{toolStateLabel(state)} · {toolName.replaceAll("_", " ")}</strong>
          {target ? <small title={target}>{target}</small> : null}
        </span>
        <Icon name="chevron-down" size={15} />
      </summary>
      <div className="tool-details">
        <div>
          <span>Input</span>
          <pre>{stringifyPreview(part.input, 1_000)}</pre>
        </div>
        {hasOutput ? (
          <div>
            <span>{state === "output-error" ? "Error" : "Result"}</span>
            <pre>{stringifyPreview(output)}</pre>
          </div>
        ) : null}
      </div>
    </details>
  );
});

type ToolUIPart = Extract<UIMessage["parts"][number], { toolCallId: string }>;

function CompletedTools({ parts }: { parts: ToolUIPart[] }) {
  const [expanded, setExpanded] = useState(false);
  return <details className="completed-tools" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary><Icon name="check" size={15} /><span>{parts.length} completed tool calls</span><Icon name="chevron-down" size={14} /></summary>
    {expanded ? <div>{parts.map(part => <ToolPart key={part.toolCallId} part={part} />)}</div> : null}
  </details>;
}

function ReasoningPart({ text, streaming }: { text: string; streaming: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return <details className="reasoning-part" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>{streaming ? "Thinking…" : "Reasoning"}</summary>
    {expanded ? <MessageMarkdown text={text} streaming={streaming} /> : null}
  </details>;
}

export const ChatMessage = memo(function ChatMessage({ message }: ChatMessageProps) {
  const roleLabel = message.role === "user" ? "You" : message.role === "assistant" ? "Lightcode" : "System";
  const visibleParts = message.parts.filter((part) => part.type !== "step-start");
  if (visibleParts.length === 0) return null;

  return (
    <article className={`chat-message role-${message.role}`}>
      <header>
        <span className="role-mark">
          <Icon name={message.role === "assistant" ? "lightcode" : message.role === "user" ? "arrow-up" : "settings"} size={14} />
        </span>
        <span>{roleLabel}</span>
      </header>
      <div className="message-parts">
        {visibleParts.map((part, index) => {
          const key = `${message.id}-${part.type}-${index}`;
          if (isToolUIPart(part) && part.state === "output-available") {
            const previous = visibleParts[index - 1];
            if (previous && isToolUIPart(previous) && previous.state === "output-available") return null;
            const group: ToolUIPart[] = [];
            for (let cursor = index; cursor < visibleParts.length; cursor++) {
              const candidate = visibleParts[cursor];
              if (!candidate || !isToolUIPart(candidate) || candidate.state !== "output-available") break;
              group.push(candidate);
            }
            return group.length > 1 ? <CompletedTools key={key} parts={group} /> : <ToolPart key={key} part={part} />;
          }
          if (part.type === "text") return <MessageMarkdown key={key} text={part.text} streaming={part.state === "streaming"} />;
          if (part.type === "reasoning") {
            return <ReasoningPart key={key} text={part.text} streaming={part.state === "streaming"} />;
          }
          if (isToolUIPart(part)) return <ToolPart key={key} part={part} />;
          if (part.type === "source-url") {
            const href = safeExternalUrl(part.url);
            return href ? (
              <a className="source-link" href={href} target="_blank" rel="noreferrer" key={key}>
                <Icon name="search" size={14} />
                <span>{part.title ?? part.url}</span>
              </a>
            ) : null;
          }
          if (part.type === "source-document") {
            return <div className="source-link static" key={key}><Icon name="instructions" size={14} /><span>{part.title}</span></div>;
          }
          if (part.type === "file") {
            return <div className="attachment-line" key={key}><Icon name="code" size={14} />{part.filename ?? part.mediaType}</div>;
          }
          return null;
        })}
      </div>
    </article>
  );
});
