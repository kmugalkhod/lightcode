import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { memo, useState } from "react";
import { MessageMarkdown } from "./message-markdown";
import { Icon, type IconName } from "./icons";
import { ToolViewBody } from "./tool-parts/tool-view-body";
import { commandFailed, toolView, toolViewBadge } from "./tool-parts/tool-view";

interface ChatMessageProps {
  message: UIMessage;
}

type MessagePart = UIMessage["parts"][number];
type ToolUIPart = Extract<MessagePart, { toolCallId: string }>;
type ReasoningUIPart = Extract<MessagePart, { type: "reasoning" }>;
type ActivityPart = ToolUIPart | ReasoningUIPart;

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

function inputString(input: unknown, keys: string[]): string | null {
  if (!input || typeof input !== "object") return null;
  for (const key of keys) {
    const value = Reflect.get(input, key);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function baseName(path: string) {
  return path.replaceAll("\\", "/").replace(/\/$/, "").split("/").at(-1) || path;
}

type ToolCategory = "read" | "edit" | "command" | "search" | "other";

interface ToolDescription {
  icon: IconName;
  category: ToolCategory;
  done: string;
  active: string;
  target: string | null;
  /** Full value for the tooltip when the target is shortened. */
  fullTarget: string | null;
}

function describeTool(toolName: string, input: unknown): ToolDescription {
  const path = inputString(input, ["path", "file_path"]);
  const pathTarget = path ? baseName(path) : null;
  switch (toolName) {
    case "read_file":
      return { icon: "document", category: "read", done: "Read", active: "Reading", target: pathTarget, fullTarget: path };
    case "edit_file":
      return { icon: "code", category: "edit", done: "Edited", active: "Editing", target: pathTarget, fullTarget: path };
    case "write_file":
      return { icon: "code", category: "edit", done: "Wrote", active: "Writing", target: pathTarget, fullTarget: path };
    case "bash": {
      const command = inputString(input, ["command"]);
      const background = Boolean(input && typeof input === "object" && Reflect.get(input, "runInBackground") === true);
      return background
        ? { icon: "terminal", category: "command", done: "Started", active: "Starting", target: command, fullTarget: command }
        : { icon: "terminal", category: "command", done: "Ran", active: "Running", target: command, fullTarget: command };
    }
    case "bash_output": {
      const jobId = inputString(input, ["jobId"]);
      return { icon: "terminal", category: "command", done: "Checked", active: "Checking", target: jobId, fullTarget: jobId };
    }
    case "bash_stop": {
      const jobId = inputString(input, ["jobId"]);
      return { icon: "terminal", category: "command", done: "Stopped", active: "Stopping", target: jobId, fullTarget: jobId };
    }
    case "call_mcp_tool": {
      const server = inputString(input, ["server"]);
      const mcpTool = inputString(input, ["toolName"]);
      const target = server && mcpTool ? `${server}/${mcpTool}` : (mcpTool ?? server);
      return { icon: "tool", category: "other", done: "Called", active: "Calling", target, fullTarget: target };
    }
    case "list_mcp_tools": {
      const server = inputString(input, ["server"]);
      return { icon: "tool", category: "other", done: "Listed MCP tools", active: "Listing MCP tools", target: server, fullTarget: server };
    }
    case "grep": {
      const query = inputString(input, ["pattern", "query"]);
      return { icon: "search", category: "search", done: "Searched for", active: "Searching for", target: query, fullTarget: query };
    }
    case "glob_search": {
      const pattern = inputString(input, ["pattern", "query"]);
      return { icon: "search", category: "search", done: "Found files", active: "Finding files", target: pattern, fullTarget: pattern };
    }
    case "list_files":
      return { icon: "folder", category: "search", done: "Listed", active: "Listing", target: pathTarget ?? ".", fullTarget: path };
    case "web_search": {
      const query = inputString(input, ["query"]);
      return { icon: "search", category: "search", done: "Searched the web for", active: "Searching the web for", target: query, fullTarget: query };
    }
    case "web_fetch": {
      const url = inputString(input, ["url"]);
      let host = url;
      try {
        if (url) host = new URL(url).host;
      } catch {
        // Keep the raw value.
      }
      return { icon: "download", category: "other", done: "Fetched", active: "Fetching", target: host, fullTarget: url };
    }
    case "todo_write":
      return { icon: "instructions", category: "other", done: "Updated the plan", active: "Updating the plan", target: null, fullTarget: null };
    case "skill": {
      const name = inputString(input, ["name", "skill"]);
      return { icon: "spark", category: "other", done: "Loaded skill", active: "Loading skill", target: name, fullTarget: name };
    }
    default: {
      const label = toolName.replaceAll("_", " ");
      const target = inputString(input, ["path", "command", "query", "pattern", "url", "description"]);
      return {
        icon: "tool",
        category: "other",
        done: label.charAt(0).toUpperCase() + label.slice(1),
        active: label.charAt(0).toUpperCase() + label.slice(1),
        target,
        fullTarget: target,
      };
    }
  }
}

function isToolFinished(part: ToolUIPart) {
  return part.state === "output-available" || part.state === "output-error" || part.state === "output-denied";
}

function isActivityPart(part: MessagePart): part is ActivityPart {
  return isToolUIPart(part) || part.type === "reasoning";
}

function isActivityRunning(part: ActivityPart) {
  return part.type === "reasoning" ? part.state === "streaming" : !isToolFinished(part);
}

function needsAttention(part: ActivityPart) {
  return part.type !== "reasoning" && (part.state === "approval-requested" || part.state === "output-error");
}

const ToolLine = memo(function ToolLine({ part }: { part: ToolUIPart }) {
  const toolName = getToolName(part);
  const state = part.state;
  const description = describeTool(toolName, part.input);
  const finished = isToolFinished(part);
  const hasOutput = finished;
  const output =
    state === "output-available"
      ? part.output
      : state === "output-error"
        ? part.errorText
        : state === "output-denied"
          ? part.approval.reason ?? "Tool execution was denied."
          : null;
  const view = state === "output-available" ? toolView(toolName, part.output) : { kind: "generic" as const };
  const badge = toolViewBadge(view);
  const verb = finished ? description.done : description.active;
  const note =
    state === "output-error"
      ? "Failed"
      : state === "output-denied"
        ? "Denied"
        : state === "approval-requested"
          ? "Approval needed"
          : null;
  const rawDetails = (
    <>
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
    </>
  );

  return (
    <details className={`activity-item tool-event state-${state}`} open={state === "approval-requested" || state === "output-error" ? true : undefined}>
      <summary>
        <span className="activity-icon">
          {finished || state === "approval-requested" ? (
            <Icon name={state === "output-error" || state === "approval-requested" ? "warning" : description.icon} size={14} />
          ) : (
            <span className="activity-spinner" aria-hidden="true" />
          )}
        </span>
        <span className="activity-label">
          <span className="activity-verb">{verb}</span>
          {description.target ? (
            <code className="activity-target" title={description.fullTarget ?? description.target}>{description.target}</code>
          ) : null}
        </span>
        {note ? <span className="activity-note">{note}</span> : null}
        {badge ? (
          <span className={commandFailed(view) ? "tool-badge failed" : "tool-badge"}>
            {badge}
          </span>
        ) : null}
        <Icon className="activity-chevron" name="chevron-right" size={13} />
      </summary>
      <div className="tool-details">
        {view.kind === "generic" ? rawDetails : (
          <>
            <ToolViewBody view={view} />
            <details className="tool-raw">
              <summary>Details</summary>
              {rawDetails}
            </details>
          </>
        )}
      </div>
    </details>
  );
});

function ReasoningLine({ part }: { part: ReasoningUIPart }) {
  const [expanded, setExpanded] = useState(false);
  const streaming = part.state === "streaming";
  if (!part.text.trim() && !streaming) return null;
  return (
    <details className="activity-item reasoning-part" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        <span className="activity-icon">
          {streaming ? <span className="activity-spinner" aria-hidden="true" /> : <Icon name="spark" size={14} />}
        </span>
        <span className="activity-label"><span className={streaming ? "activity-verb shimmer" : "activity-verb"}>{streaming ? "Thinking" : "Thought"}</span></span>
        <Icon className="activity-chevron" name="chevron-right" size={13} />
      </summary>
      {expanded ? <div className="reasoning-body"><MessageMarkdown text={part.text} streaming={streaming} /></div> : null}
    </details>
  );
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/** "Read 3 files, ran 2 commands" — what a finished stretch of work did. */
export function summarizeActivity(parts: ActivityPart[]): string {
  const counts: Record<ToolCategory, number> = { read: 0, edit: 0, command: 0, search: 0, other: 0 };
  let thoughts = 0;
  for (const part of parts) {
    if (part.type === "reasoning") thoughts += 1;
    else counts[describeTool(getToolName(part), part.input).category] += 1;
  }
  const phrases = [
    counts.read ? `read ${plural(counts.read, "file", "files")}` : null,
    counts.edit ? `edited ${plural(counts.edit, "file", "files")}` : null,
    counts.command ? `ran ${plural(counts.command, "command", "commands")}` : null,
    counts.search ? plural(counts.search, "search", "searches") : null,
    counts.other ? plural(counts.other, "other step", "other steps") : null,
  ].filter(Boolean);
  if (phrases.length === 0) return thoughts ? "Thought it through" : "Worked";
  const sentence = phrases.join(", ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function ActivityItems({ parts }: { parts: ActivityPart[] }) {
  return (
    <div className="activity-list">
      {parts.map((part, index) =>
        part.type === "reasoning" ? (
          <ReasoningLine key={`reasoning-${index}`} part={part} />
        ) : (
          <ToolLine key={part.toolCallId} part={part} />
        ),
      )}
    </div>
  );
}

/** Steps shown inline before they are folded behind a summary line. */
const inlineActivityLimit = 2;

/**
 * Settled steps fold behind one summary line; anything still running, failed,
 * or waiting for approval stays visible beneath it.
 */
function ActivityGroup({ parts }: { parts: ActivityPart[] }) {
  const [open, setOpen] = useState(false);
  const visibleSteps = parts.filter((part) => part.type !== "reasoning" || part.text.trim() || part.state === "streaming");

  if (visibleSteps.length <= inlineActivityLimit) return <ActivityItems parts={visibleSteps} />;

  const live = visibleSteps.filter((part) => isActivityRunning(part) || needsAttention(part));
  const settled = visibleSteps.filter((part) => !live.includes(part));
  if (settled.length === 0) return <ActivityItems parts={visibleSteps} />;

  return (
    <div className={open ? "activity-group open" : "activity-group"}>
      <button className="activity-summary" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{summarizeActivity(settled)}</span>
        <Icon name="chevron-right" size={13} />
      </button>
      {open ? <ActivityItems parts={visibleSteps} /> : live.length > 0 ? <ActivityItems parts={live} /> : null}
    </div>
  );
}

export const ChatMessage = memo(function ChatMessage({ message }: ChatMessageProps) {
  const roleLabel = message.role === "user" ? "You" : message.role === "assistant" ? "Lightcode" : "System";
  const visibleParts = message.parts.filter((part) => part.type !== "step-start");
  if (visibleParts.length === 0) return null;

  const blocks: Array<{ kind: "activity"; parts: ActivityPart[] } | { kind: "part"; part: MessagePart }> = [];
  for (const part of visibleParts) {
    if (isActivityPart(part)) {
      const last = blocks.at(-1);
      if (last?.kind === "activity") last.parts.push(part);
      else blocks.push({ kind: "activity", parts: [part] });
    } else {
      blocks.push({ kind: "part", part });
    }
  }

  return (
    <article className={`chat-message role-${message.role}`}>
      <h2 className="sr-only">{roleLabel}</h2>
      <div className="message-parts">
        {blocks.map((block, index) => {
          const key = `${message.id}-${index}`;
          if (block.kind === "activity") return <ActivityGroup key={key} parts={block.parts} />;
          const part = block.part;
          if (part.type === "text") return <MessageMarkdown key={key} text={part.text} streaming={part.state === "streaming"} />;
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
