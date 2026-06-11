import path from "node:path";

interface SessionExportJson {
  exportedAt: string;
  session: {
    id: string;
    title: string | null;
    cwd: string | null;
    mode: string;
    permissionMode: string | null;
    model: string | null;
    revision: number;
    createdAt: string;
    updatedAt: string;
  };
  messages: unknown[];
}

interface UIMessagePart {
  type: string;
  [key: string]: unknown;
}

interface UIMessage {
  id: string;
  role: "user" | "assistant" | "system";
  parts: UIMessagePart[];
  createdAt?: number | string;
}

/**
 * Escapes markdown special characters in text for display in markdown.
 */
function escapeMarkdown(text: string): string {
  // Escape order matters: code blocks first, then other special chars
  return text
    .replace(/```/g, "\\`\\`\\`")
    .replace(/`/g, "\\`")
    .replace(/\*\*([^*]+)\*\*/g, "$1") // Remove bold markers but keep text
    .replace(/\*([^*]+)\*/g, "$1") // Remove italic markers but keep text
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1");
}

/**
 * Safely slugifies a title for use as a filename.
 */
function slugifyTitle(title: string | null | undefined): string {
  if (!title) {
    return "";
  }
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Formats a timestamp for display in the markdown file.
 */
function formatDate(isoString: string): string {
  try {
    return new Date(isoString).toLocaleString();
  } catch {
    return isoString;
  }
}

/**
 * Extracts text content from a message part.
 */
function extractPartText(part: UIMessagePart): string {
  switch (part.type) {
    case "text":
      return escapeMarkdown(String(part.text ?? ""));

    case "tool-call": {
      const toolName = String(part.toolName ?? "unknown");
      const toolArgs = part.args ? JSON.stringify(part.args, null, 2) : "{}";
      return `\`\`\`tool-call\n${toolName}\n\`\`\`\n\`\`\`json\n${toolArgs}\n\`\`\``;
    }

    case "tool-result": {
      const toolCallId = String(part.toolCallId ?? "");
      const toolResult = part.result !== undefined ? JSON.stringify(part.result, null, 2) : "";
      return `\`\`\`tool-result[${toolCallId}]\n${toolResult}\n\`\`\``;
    }

    case "reasoning": {
      const reasoning = String(part.reasoning ?? "");
      return `*Thinking...*\n${escapeMarkdown(reasoning)}`;
    }

    case "image": {
      const alt = part.alt ? String(part.alt) : "image";
      return `![${alt}](image)`;
    }

    case "file": {
      const fileName = String(part.fileName ?? "file");
      return `[File: ${fileName}]`;
    }

    case "citation": {
      const citation = part.citation
        ? JSON.stringify(part.citation, null, 2)
        : "{}";
      return `\`\`\`citation\n${citation}\n\`\`\``;
    }

    default:
      return "";
  }
}

/**
 * Converts a single message to markdown format.
 */
function formatMessageAsMarkdown(message: UIMessage): string {
  const roleLabel = message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : "System";

  const partsContent = message.parts
    .map((part) => extractPartText(part))
    .filter((text) => text.length > 0)
    .join("\n\n");

  if (!partsContent) {
    return `## ${roleLabel}\n\n*No content*`;
  }

  return `## ${roleLabel}\n\n${partsContent}`;
}

/**
 * Converts a session export JSON to a clean markdown file.
 */
export function sessionToMarkdown(data: SessionExportJson): string {
  const { session, messages, exportedAt } = data;

  // Build front matter
  const frontMatter = [
    "---",
    `title: ${session.title ?? "Untitled Session"}`,
    `date: ${formatDate(session.createdAt)}`,
    `exported: ${formatDate(exportedAt)}`,
    session.model ? `model: ${session.model}` : null,
    `mode: ${session.mode}`,
    session.permissionMode ? `permission-mode: ${session.permissionMode}` : null,
    session.cwd ? `cwd: ${session.cwd}` : null,
    `session-id: ${session.id}`,
    "---",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");

  // Convert each message
  const messagesMarkdown = messages
    .map((msg) => {
      const message = msg as UIMessage;
      if (!message.role || !message.parts) {
        // Skip malformed messages
        return null;
      }
      return formatMessageAsMarkdown(message);
    })
    .filter((md): md is string => md !== null)
    .join("\n\n---\n\n");

  return `${frontMatter}\n${messagesMarkdown}`;
}

/**
 * Generates a safe filename for the markdown export.
 */
export function generateExportFilename(sessionTitle: string | null | undefined, sessionId: string): string {
  const slug = slugifyTitle(sessionTitle);

  if (slug) {
    return `${slug}.md`;
  }

  // Fallback to session ID with timestamp
  const timestamp = new Date().toISOString().split("T")[0];
  return `lightcode-session-${timestamp}.md`;
}

/**
 * Default export directory (current working directory).
 */
export function getExportDirectory(): string {
  return process.cwd();
}

/**
 * Gets the full export path for a session.
 */
export function getExportPath(sessionTitle: string | null | undefined, sessionId: string): string {
  return path.join(getExportDirectory(), generateExportFilename(sessionTitle, sessionId));
}
