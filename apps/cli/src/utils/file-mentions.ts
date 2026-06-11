import { promises as fs } from "node:fs";
import path from "node:path";

export const MAX_MENTION_FILES = 4;
export const MAX_MENTION_FILE_CHARS = 16_000;

const mentionTokenPattern = /(?:^|\s)@([A-Za-z0-9_.@/\\-]+)/g;

const fenceLanguageByExtension: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  json: "json",
  md: "markdown",
  css: "css",
  html: "html",
  py: "python",
  rs: "rust",
  go: "go",
  sh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  prisma: "prisma",
  sql: "sql",
};

export function extractFileMentions(text: string): string[] {
  const mentions = new Set<string>();
  for (const match of text.matchAll(mentionTokenPattern)) {
    const candidate = match[1].replace(/[).,;:!?]+$/, "");
    if (candidate) {
      mentions.add(candidate);
    }
  }

  return [...mentions];
}

function getFenceLanguage(filePath: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase();
  return (extension && fenceLanguageByExtension[extension]) ?? "";
}

/**
 * Expands `@path` mentions into fenced attachment blocks appended to the
 * outgoing message. Plain text keeps transport and persistence untouched.
 * Unknown paths are ignored (the token stays as the user typed it).
 */
export async function appendMentionAttachments(
  text: string,
  cwd: string,
): Promise<string> {
  const mentionPaths = extractFileMentions(text).slice(0, MAX_MENTION_FILES);
  if (mentionPaths.length === 0) {
    return text;
  }

  const attachmentBlocks: string[] = [];
  for (const mentionPath of mentionPaths) {
    const absolutePath = path.resolve(cwd, mentionPath);
    if (!absolutePath.startsWith(path.resolve(cwd))) {
      continue;
    }

    try {
      const stats = await fs.stat(absolutePath);
      if (!stats.isFile()) {
        continue;
      }

      let content = await fs.readFile(absolutePath, "utf8");
      let truncated = false;
      if (content.length > MAX_MENTION_FILE_CHARS) {
        content = content.slice(0, MAX_MENTION_FILE_CHARS);
        truncated = true;
      }

      attachmentBlocks.push(
        [
          `Attached file: ${mentionPath}${truncated ? " (truncated)" : ""}`,
          `\`\`\`${getFenceLanguage(mentionPath)}`,
          content,
          "```",
        ].join("\n"),
      );
    } catch {
      // Path does not exist or is unreadable — leave the mention as text.
    }
  }

  if (attachmentBlocks.length === 0) {
    return text;
  }

  return `${text}\n\n${attachmentBlocks.join("\n\n")}`;
}
