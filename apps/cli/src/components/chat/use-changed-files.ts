import { useMemo } from "react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import {
  countDiffStats,
  getFileEditDiff,
  type AnyToolPart,
} from "./chat-message-tool-invocation-part";

/** Tools whose invocations represent a file mutation we want to surface. */
const EDIT_TOOL_NAMES = new Set(["edit_file", "write_file"]);

export type ChangedFileStatus = "streaming" | "done";

/**
 * How the file was touched. Derived from tool output where possible so the panel
 * can label rows (created vs modified vs deleted) without re-parsing the diff.
 */
export type ChangedFileChangeKind =
  | "created"
  | "modified"
  | "deleted"
  | "untracked"
  | "renamed";

export interface ChangedFile {
  /** Workspace-relative path as reported by the tool. */
  path: string;
  /** Latest unified diff for the file; empty string while only streaming. */
  diff: string;
  addedLines: number;
  removedLines: number;
  /** toolCallId of the most recent tool part that touched this file. */
  lastToolPartId: string;
  status: ChangedFileStatus;
  changeKind: ChangedFileChangeKind;
  /**
   * Monotonic counter (within one reduce) of when this file was last touched.
   * Higher means more recent — used to auto-select the newest change while the
   * list itself stays in stable first-touched order.
   */
  lastTouchedSeq: number;
}

function readStringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const field = Reflect.get(value, key);
  return typeof field === "string" && field.trim().length > 0 ? field : null;
}

/** Path from a still-streaming Edit/Write part, taken from its input args. */
function getInFlightEditPath(part: AnyToolPart): string | null {
  return readStringField(part.input, "path");
}

/**
 * Classify a completed edit. `write_file` reports `created`; an empty result
 * file (all `-` lines, no `+`) reads as a delete; everything else is a modify.
 */
function classifyCompletedEdit(
  part: AnyToolPart,
  added: number,
  removed: number,
): ChangedFileChangeKind {
  if (part.state === "output-available") {
    const created = Reflect.get(part.output as object, "created");
    if (created === true) {
      return "created";
    }
  }
  if (added === 0 && removed > 0) {
    return "deleted";
  }
  return "modified";
}

/**
 * Reduce the chat `messages` array into an ordered list of files the agent
 * touched. Dedupes by path keeping the latest diff, but preserves the order in
 * which each path was first touched so the list stays stable as edits stream.
 */
export function collectChangedFiles(messages: UIMessage[]): ChangedFile[] {
  const order: string[] = [];
  const byPath = new Map<string, ChangedFile>();
  let touchSeq = 0;

  const upsert = (next: Omit<ChangedFile, "lastTouchedSeq">) => {
    if (!byPath.has(next.path)) {
      order.push(next.path);
    }
    byPath.set(next.path, { ...next, lastTouchedSeq: touchSeq++ });
  };

  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolUIPart(part)) {
        continue;
      }
      if (!EDIT_TOOL_NAMES.has(getToolName(part))) {
        continue;
      }

      const completed = getFileEditDiff(part);
      if (completed) {
        const { added, removed } = countDiffStats(completed.diff);
        upsert({
          path: completed.path,
          diff: completed.diff,
          addedLines: added,
          removedLines: removed,
          lastToolPartId: part.toolCallId,
          status: "done",
          changeKind: classifyCompletedEdit(part, added, removed),
        });
        continue;
      }

      if (part.state === "input-streaming" || part.state === "input-available") {
        const path = getInFlightEditPath(part);
        if (!path) {
          continue;
        }
        // Keep any diff/stats from a prior completed edit of the same file so the
        // row doesn't blank out while a follow-up edit is mid-flight.
        const prev = byPath.get(path);
        upsert({
          path,
          diff: prev?.diff ?? "",
          addedLines: prev?.addedLines ?? 0,
          removedLines: prev?.removedLines ?? 0,
          lastToolPartId: part.toolCallId,
          status: "streaming",
          changeKind: prev?.changeKind ?? "modified",
        });
      }
    }
  }

  return order.map((path) => byPath.get(path)!);
}

/** The file touched most recently, or null when nothing has changed. */
export function getMostRecentChangedFile(files: ChangedFile[]): ChangedFile | null {
  let newest: ChangedFile | null = null;
  for (const file of files) {
    if (!newest || file.lastTouchedSeq > newest.lastTouchedSeq) {
      newest = file;
    }
  }
  return newest;
}

/** Memoized view of every file the agent has touched in this conversation. */
export function useChangedFiles(messages: UIMessage[]): ChangedFile[] {
  return useMemo(() => collectChangedFiles(messages), [messages]);
}
