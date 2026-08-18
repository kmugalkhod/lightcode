import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { FileReferenceUIPart } from "@lightcode/ai";

export const MAX_MENTION_FILES = 4;

const mentionTokenPattern = /(?:^|\s)@([A-Za-z0-9_.@/\\-]+)/g;

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

/**
 * Resolves `@path` mentions to immutable references. File bytes never enter
 * the client transcript; the server validates and materializes a bounded view
 * only for the provider request that needs it.
 */
export async function resolveMentionAttachments(
  text: string,
  cwd: string,
): Promise<{ text: string; parts: FileReferenceUIPart[] }> {
  const mentionPaths = extractFileMentions(text).slice(0, MAX_MENTION_FILES);
  if (mentionPaths.length === 0) {
    return { text, parts: [] };
  }

  const root = await fs.realpath(path.resolve(cwd));
  const parts: FileReferenceUIPart[] = [];
  for (const mentionPath of mentionPaths) {
    try {
      const absolutePath = await fs.realpath(path.resolve(root, mentionPath));
      const relativePath = path.relative(root, absolutePath);
      if (
        !relativePath ||
        relativePath.startsWith(`..${path.sep}`) ||
        relativePath === ".." ||
        path.isAbsolute(relativePath)
      ) {
        continue;
      }
      const stats = await fs.stat(absolutePath);
      if (!stats.isFile()) {
        continue;
      }
      const content = await fs.readFile(absolutePath);
      parts.push({
        type: "data-file-ref",
        data: {
          path: relativePath.split(path.sep).join("/"),
          contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        },
      });
    } catch {
      // Path does not exist or is unreadable — leave the mention as text.
    }
  }

  return { text, parts };
}
