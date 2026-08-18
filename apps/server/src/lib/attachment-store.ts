import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  blobReferenceUIPartSchema,
  fileReferenceUIPartSchema,
} from "@lightcode/ai";
import { getLightcodeDataDir } from "@lightcode/shared";
import type { UIMessage } from "ai";

const maxMaterializedFileChars = 8_000;
const maxMaterializedFileCharsPerTurn = 20_000;
const maxMaterializedBlobBytes = 16 * 1024 * 1024;

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function blobPath(contentHash: string): string {
  const hex = contentHash.slice("sha256:".length);
  return path.join(getLightcodeDataDir(), "blobs", hex.slice(0, 2), hex);
}

function parseDataUrl(value: string): { mediaType: string; bytes: Uint8Array } | null {
  const match = value.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!match) {
    return null;
  }
  try {
    return {
      mediaType: match[1] || "application/octet-stream",
      bytes: match[2]
        ? Uint8Array.from(Buffer.from(match[3], "base64"))
        : new TextEncoder().encode(decodeURIComponent(match[3])),
    };
  } catch {
    return null;
  }
}

async function persistBlob(bytes: Uint8Array, contentHash: string) {
  const target = blobPath(contentHash);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null
        ? Reflect.get(error, "code")
        : null;
    if (code !== "EEXIST") {
      throw error;
    }
  }
}

/** Replaces inline data-URL files with content-addressed references. */
export async function storeInlineMessageBlobs(
  messages: readonly UIMessage[],
): Promise<UIMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      let changed = false;
      const parts: UIMessage["parts"] = [];
      for (const part of message.parts) {
        if (part.type !== "file" || !part.url.startsWith("data:")) {
          parts.push(part);
          continue;
        }
        const parsed = parseDataUrl(part.url);
        if (!parsed) {
          parts.push(part);
          continue;
        }
        const contentHash = digest(parsed.bytes);
        await persistBlob(parsed.bytes, contentHash);
        changed = true;
        parts.push({
          type: "data-blob-ref",
          data: {
            contentHash,
            mediaType: part.mediaType || parsed.mediaType,
            ...(part.filename ? { filename: part.filename } : {}),
            size: parsed.bytes.byteLength,
          },
        });
      }
      return changed ? { ...message, parts } : message;
    }),
  );
}

function withinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function priorReferenceText(kind: "file" | "blob", label: string) {
  return {
    type: "text" as const,
    text: `[Previously attached ${kind}: ${label}. Read it again only if needed.]`,
  };
}

/**
 * Materializes only the latest user turn's references. Older attachments stay
 * as compact handles, preventing the same file/base64 payload from consuming
 * every later provider request while preserving complete local history.
 */
export async function materializeProviderAttachments({
  messages,
  cwd,
}: {
  messages: readonly UIMessage[];
  cwd: string;
}): Promise<UIMessage[]> {
  const canonicalRoot = await fs.realpath(path.resolve(cwd));
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  let remainingFileChars = maxMaterializedFileCharsPerTurn;

  return Promise.all(
    messages.map(async (message, messageIndex) => {
      const isLatestUser = messageIndex === latestUserIndex;
      const parts: UIMessage["parts"] = [];
      let changed = false;

      for (const part of message.parts) {
        const fileReference = fileReferenceUIPartSchema.safeParse(part);
        if (fileReference.success) {
          changed = true;
          const reference = fileReference.data.data;
          if (!isLatestUser) {
            parts.push(priorReferenceText("file", reference.path));
            continue;
          }
          try {
            const candidate = await fs.realpath(
              path.resolve(canonicalRoot, reference.path),
            );
            if (!withinRoot(canonicalRoot, candidate)) {
              throw new Error("outside workspace");
            }
            const bytes = await fs.readFile(candidate);
            if (digest(bytes) !== reference.contentHash) {
              parts.push({
                type: "text",
                text: `[Attached file changed since selection: ${reference.path}. Use read_file for the current contents.]`,
              });
              continue;
            }
            let content = bytes.toString("utf8");
            if (reference.range) {
              content = content
                .split(/\r?\n/)
                .slice(reference.range.startLine - 1, reference.range.endLine)
                .join("\n");
            }
            const limit = Math.min(maxMaterializedFileChars, remainingFileChars);
            const truncated = content.length > limit;
            content = content.slice(0, limit);
            remainingFileChars -= content.length;
            parts.push({
              type: "text",
              text: `<attached_file path="${reference.path}" hash="${reference.contentHash}"${truncated ? ' truncated="true"' : ""}>\n${content}\n</attached_file>`,
            });
          } catch {
            parts.push({
              type: "text",
              text: `[Attached file is unavailable: ${reference.path}.]`,
            });
          }
          continue;
        }

        const blobReference = blobReferenceUIPartSchema.safeParse(part);
        if (blobReference.success) {
          changed = true;
          const reference = blobReference.data.data;
          const label = reference.filename ?? reference.contentHash;
          if (!isLatestUser) {
            parts.push(priorReferenceText("blob", label));
            continue;
          }
          try {
            if (reference.size > maxMaterializedBlobBytes) {
              throw new Error("blob too large");
            }
            const bytes = await fs.readFile(blobPath(reference.contentHash));
            if (bytes.byteLength !== reference.size || digest(bytes) !== reference.contentHash) {
              throw new Error("blob integrity mismatch");
            }
            parts.push({
              type: "file",
              mediaType: reference.mediaType,
              ...(reference.filename ? { filename: reference.filename } : {}),
              url: `data:${reference.mediaType};base64,${bytes.toString("base64")}`,
            });
          } catch {
            parts.push({
              type: "text",
              text: `[Attached blob is unavailable: ${label}.]`,
            });
          }
          continue;
        }

        parts.push(part);
      }

      return changed ? { ...message, parts } : message;
    }),
  );
}
