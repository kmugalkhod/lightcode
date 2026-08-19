import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Icon } from "./icons";

interface ChatMessageProps {
  message: UIMessage;
}

function cleanLanguage(value: string) {
  return value.trim().replace(/[^a-z0-9_+#.-]/gi, "").slice(0, 32);
}

const inlineMarkdownPattern = /(`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;

function inlineMarkdown(value: string, keyPrefix: string): ReactNode[] {
  const result: ReactNode[] = [];
  let cursor = 0;
  let index = 0;
  for (const match of value.matchAll(inlineMarkdownPattern)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > cursor) result.push(value.slice(cursor, matchIndex));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.startsWith("`")) {
      result.push(<code className="inline-code" key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("[")) {
      const parsed = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      const href = parsed ? safeExternalUrl(parsed[2] ?? "") : null;
      result.push(
        href ? (
          <a href={href} target="_blank" rel="noreferrer" key={key}>{parsed?.[1]}</a>
        ) : token,
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      result.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      result.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    cursor = matchIndex + token.length;
  }
  if (cursor < value.length) result.push(value.slice(cursor));
  return result;
}

function MarkdownText({ value, blockKey }: { value: string; blockKey: string }) {
  const lines = value.replaceAll("\r\n", "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      blocks.push(
        <p className={`markdown-heading level-${level}`} key={`${blockKey}-heading-${index}`}>
          {inlineMarkdown(heading[2] ?? "", `${blockKey}-heading-${index}`)}
        </p>,
      );
      index += 1;
      continue;
    }

    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const orderedList = Boolean(ordered);
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const current = orderedList
          ? /^\s*\d+[.)]\s+(.+)$/.exec(lines[index] ?? "")
          : /^\s*[-*+]\s+(.+)$/.exec(lines[index] ?? "");
        if (!current) break;
        items.push(
          <li key={`${blockKey}-item-${index}`}>
            {inlineMarkdown(current[1] ?? "", `${blockKey}-item-${index}`)}
          </li>,
        );
        index += 1;
      }
      blocks.push(
        orderedList
          ? <ol key={`${blockKey}-list-${index}`}>{items}</ol>
          : <ul key={`${blockKey}-list-${index}`}>{items}</ul>,
      );
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index] ?? "")) {
        quoted.push((lines[index] ?? "").replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(
        <blockquote key={`${blockKey}-quote-${index}`}>
          {inlineMarkdown(quoted.join("\n"), `${blockKey}-quote-${index}`)}
        </blockquote>,
      );
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (
        !current.trim() ||
        /^(#{1,6})\s+/.test(current) ||
        /^\s*[-*+]\s+/.test(current) ||
        /^\s*\d+[.)]\s+/.test(current) ||
        /^>\s?/.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push(
      <p key={`${blockKey}-paragraph-${index}`}>
        {paragraph.map((paragraphLine, lineIndex) => (
          <Fragment key={`${blockKey}-line-${index}-${lineIndex}`}>
            {lineIndex > 0 ? "\n" : null}
            {inlineMarkdown(paragraphLine, `${blockKey}-line-${index}-${lineIndex}`)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return blocks;
}

function TextPart({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const result: Array<
      | { kind: "text"; value: string }
      | { kind: "code"; value: string; language: string }
    > = [];
    const pattern = /```([^\n]*)\n([\s\S]*?)```/g;
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > cursor) {
        result.push({ kind: "text", value: text.slice(cursor, index) });
      }
      result.push({
        kind: "code",
        language: cleanLanguage(match[1] ?? ""),
        value: (match[2] ?? "").replace(/\n$/, ""),
      });
      cursor = index + match[0].length;
    }
    if (cursor < text.length) {
      result.push({ kind: "text", value: text.slice(cursor) });
    }
    return result.length > 0 ? result : [{ kind: "text" as const, value: text }];
  }, [text]);

  return (
    <div className="message-text">
      {blocks.map((block, index) =>
        block.kind === "code" ? (
          <div className="code-block" key={`${block.language}-${index}`}>
            <div className="code-header">
              <span>{block.language || "code"}</span>
              <CopyButton value={block.value} />
            </div>
            <pre><code>{block.value}</code></pre>
          </div>
        ) : (
          <MarkdownText key={index} value={block.value} blockKey={`text-${index}`} />
        ),
      )}
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_200);
    } catch {
      // Clipboard access can be unavailable in restricted browser contexts.
    }
  }
  return (
    <button type="button" onClick={() => void copy()}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
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

function ToolPart({ part }: { part: Extract<UIMessage["parts"][number], { toolCallId: string }> }) {
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
}

export function ChatMessage({ message }: ChatMessageProps) {
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
          if (part.type === "text") return <TextPart key={key} text={part.text} />;
          if (part.type === "reasoning") {
            return (
              <details className="reasoning-part" key={key}>
                <summary>Reasoning</summary>
                <p>{part.text}</p>
              </details>
            );
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
}
