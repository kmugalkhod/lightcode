import type { UIMessage } from "ai";
import { safeStringify } from "./estimate";
import {
  getToolNameFromPart,
  isRecord,
  type UIMessagePart,
} from "./message-parts";

export const DEFAULT_PRUNE_MIN_OUTPUT_CHARS = 2_000;

/**
 * The prune cutoff only advances once every N user turns so the pruned prefix
 * stays byte-stable between requests, keeping provider prompt caches warm.
 */
export const DEFAULT_PRUNE_QUANTIZE_USER_TURNS = 4;

export interface ToolOutputElisionStub {
  lightcodeElided: true;
  note: string;
  originalChars: number;
}

export interface Tier1PruneOptions {
  preserveRecentMessages: number;
  minOutputChars?: number;
  quantizeUserTurns?: number;
}

export interface Tier1PruneResult {
  messages: UIMessage[];
  elidedToolOutputs: number;
  dedupedFileReads: number;
  savedChars: number;
}

export function isElidedToolOutput(
  output: unknown,
): output is ToolOutputElisionStub {
  return isRecord(output) && output.lightcodeElided === true;
}

function normalizeReadPathKey(input: unknown): string | null {
  if (!isRecord(input)) {
    return null;
  }

  const path = input.path;
  if (typeof path !== "string" || !path.trim()) {
    return null;
  }

  return path.trim().replaceAll("\\", "/").toLowerCase();
}

function getPartState(part: UIMessagePart): string | null {
  const state = isRecord(part) ? Reflect.get(part, "state") : undefined;
  return typeof state === "string" ? state : null;
}

/**
 * Index below which messages are prune candidates. Snapped to a user-message
 * boundary and quantized so it only moves every `quantizeUserTurns` user turns.
 */
export function computePruneCutoffIndex(
  messages: readonly UIMessage[],
  preserveRecentMessages: number,
  quantizeUserTurns: number = DEFAULT_PRUNE_QUANTIZE_USER_TURNS,
): number {
  const candidate = messages.length - preserveRecentMessages;
  if (candidate <= 0) {
    return 0;
  }

  const userIndices: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === "user") {
      userIndices.push(index);
    }
  });

  let snappedOrdinal = -1;
  for (let ordinal = 0; ordinal < userIndices.length; ordinal += 1) {
    if (userIndices[ordinal] <= candidate) {
      snappedOrdinal = ordinal;
    } else {
      break;
    }
  }

  if (snappedOrdinal < 0) {
    return 0;
  }

  const quantize = Math.max(1, quantizeUserTurns);
  const quantizedOrdinal = Math.floor(snappedOrdinal / quantize) * quantize;
  return userIndices[quantizedOrdinal];
}

function withElidedOutput(
  part: UIMessagePart,
  stub: ToolOutputElisionStub,
): UIMessagePart {
  // Tool parts are structurally open at runtime; replacing `output` keeps the
  // part valid for providers while shedding its payload.
  return { ...(part as Record<string, unknown>), output: stub } as UIMessagePart;
}

/**
 * Tier-1 context pruning: elides large tool outputs outside the recent window
 * and dedupes repeated read_file outputs (latest read wins). Pure and
 * idempotent — operates on the provider view only and is never persisted.
 */
export function pruneToolOutputs(
  messages: readonly UIMessage[],
  options: Tier1PruneOptions,
): Tier1PruneResult {
  const minOutputChars = options.minOutputChars ?? DEFAULT_PRUNE_MIN_OUTPUT_CHARS;
  const cutoff = computePruneCutoffIndex(
    messages,
    options.preserveRecentMessages,
    options.quantizeUserTurns,
  );

  const latestReadByPath = new Map<
    string,
    { messageIndex: number; partIndex: number }
  >();
  messages.forEach((message, messageIndex) => {
    message.parts.forEach((part, partIndex) => {
      if (getToolNameFromPart(part) !== "read_file") {
        return;
      }

      if (getPartState(part) !== "output-available") {
        return;
      }

      const key = normalizeReadPathKey(
        isRecord(part) ? Reflect.get(part, "input") : undefined,
      );
      if (key) {
        latestReadByPath.set(key, { messageIndex, partIndex });
      }
    });
  });

  let elidedToolOutputs = 0;
  let dedupedFileReads = 0;
  let savedChars = 0;

  const prunedMessages = messages.map((message, messageIndex) => {
    if (messageIndex >= cutoff) {
      return message;
    }

    let changed = false;
    const parts = message.parts.map((part, partIndex) => {
      const toolName = getToolNameFromPart(part);
      if (!toolName || getPartState(part) !== "output-available") {
        return part;
      }

      const output = isRecord(part) ? Reflect.get(part, "output") : undefined;
      if (isElidedToolOutput(output)) {
        return part;
      }

      const readPathKey =
        toolName === "read_file"
          ? normalizeReadPathKey(Reflect.get(part, "input"))
          : null;
      const latestRead = readPathKey
        ? latestReadByPath.get(readPathKey)
        : undefined;
      const isStaleRead = Boolean(
        latestRead &&
          !(
            latestRead.messageIndex === messageIndex &&
            latestRead.partIndex === partIndex
          ),
      );

      const serializedOutput = safeStringify(output);
      const isLarge = serializedOutput.length > minOutputChars;
      if (!isStaleRead && !isLarge) {
        return part;
      }

      const stub: ToolOutputElisionStub = {
        lightcodeElided: true,
        note: isStaleRead
          ? "Earlier read of this file elided; a later read in this conversation has the current content. Re-run read_file if needed."
          : "Large tool output elided to preserve context budget. Re-run the tool if this output is needed again.",
        originalChars: serializedOutput.length,
      };

      if (isStaleRead) {
        dedupedFileReads += 1;
      } else {
        elidedToolOutputs += 1;
      }

      savedChars += Math.max(
        0,
        serializedOutput.length - safeStringify(stub).length,
      );
      changed = true;
      return withElidedOutput(part, stub);
    });

    return changed ? { ...message, parts } : message;
  });

  return {
    messages: prunedMessages,
    elidedToolOutputs,
    dedupedFileReads,
    savedChars,
  };
}
