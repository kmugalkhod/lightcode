import type { UIMessage } from "ai";
import { PROGRESS_NOTE_PRUNE_MIN_CHARS } from "../constants";
import { safeStringify } from "./estimate";
import {
  getToolNameFromPart,
  isRecord,
  type UIMessagePart,
} from "./message-parts";

export const DEFAULT_PRUNE_MIN_OUTPUT_CHARS = 2_000;

/** Placeholder left in place of an elided progress note. */
export const PROGRESS_NOTE_ELISION_STUB = "[progress note elided]";

/** Placeholder left in place of an elided reasoning part. */
export const REASONING_ELISION_STUB = "[reasoning elided]";

/**
 * Read-only tools whose repeated identical calls are safe to dedupe: the
 * latest result reflects the current workspace, so earlier copies only cost
 * tokens. read_file is handled separately (keyed by path, not full args).
 */
const IDEMPOTENT_DEDUP_TOOLS = new Set(["grep", "glob_search", "list_files"]);

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
  /**
   * Apply superseded-call dedup to the whole history, including the preserved
   * recent window. Only safe when no prompt-cache prefix needs byte stability
   * (the elision can touch any message, not just the quantized prefix).
   */
  dedupeAcrossFullHistory?: boolean;
  /**
   * Elide reasoning parts outside the recent window. Old chain-of-thought is
   * never needed to continue a task; only worth the churn when uncached.
   */
  elideReasoningParts?: boolean;
}

export interface Tier1PruneResult {
  messages: UIMessage[];
  elidedToolOutputs: number;
  dedupedFileReads: number;
  /** Superseded idempotent tool calls (grep/glob/list) elided, latest kept. */
  dedupedToolCalls: number;
  elidedProgressNotes: number;
  elidedReasoningParts: number;
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

/** A plain `type: "text"` part's text, or null for any other part shape. */
function getPlainTextPartContent(part: UIMessagePart): string | null {
  if (!isRecord(part) || Reflect.get(part, "type") !== "text") {
    return null;
  }

  const text = Reflect.get(part, "text");
  return typeof text === "string" ? text : null;
}

function messageHasToolPart(message: UIMessage): boolean {
  return message.parts.some((part) => getToolNameFromPart(part) !== null);
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

/**
 * Dedup signature for a completed tool call: read_file keys on the normalized
 * path (a later read of the same file supersedes any earlier one, regardless
 * of range args), other idempotent tools key on their exact input.
 */
function getDedupSignature(part: UIMessagePart): string | null {
  const toolName = getToolNameFromPart(part);
  if (!toolName || getPartState(part) !== "output-available") {
    return null;
  }

  if (toolName === "read_file") {
    const key = normalizeReadPathKey(
      isRecord(part) ? Reflect.get(part, "input") : undefined,
    );
    return key ? `read_file:${key}` : null;
  }

  if (!IDEMPOTENT_DEDUP_TOOLS.has(toolName)) {
    return null;
  }

  const input = isRecord(part) ? Reflect.get(part, "input") : undefined;
  return `${toolName}:${safeStringify(input)}`;
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
 * and dedupes repeated idempotent tool calls (latest result wins). Pure and
 * idempotent — operates on the provider view only and is never persisted.
 */
export function pruneToolOutputs(
  messages: readonly UIMessage[],
  options: Tier1PruneOptions,
): Tier1PruneResult {
  const minOutputChars = options.minOutputChars ?? DEFAULT_PRUNE_MIN_OUTPUT_CHARS;
  const dedupeAcrossFullHistory = options.dedupeAcrossFullHistory ?? false;
  const elideReasoningParts = options.elideReasoningParts ?? false;
  const cutoff = computePruneCutoffIndex(
    messages,
    options.preserveRecentMessages,
    options.quantizeUserTurns,
  );

  const latestCallBySignature = new Map<
    string,
    { messageIndex: number; partIndex: number }
  >();
  messages.forEach((message, messageIndex) => {
    message.parts.forEach((part, partIndex) => {
      const signature = getDedupSignature(part);
      if (signature) {
        latestCallBySignature.set(signature, { messageIndex, partIndex });
      }
    });
  });

  let elidedToolOutputs = 0;
  let dedupedFileReads = 0;
  let dedupedToolCalls = 0;
  let elidedProgressNotes = 0;
  let elidedReasoningParts = 0;
  let savedChars = 0;

  const prunedMessages = messages.map((message, messageIndex) => {
    // Above the cutoff (the preserved recent window) only superseded-call
    // dedup may apply, and only when the caller opted into full-history dedup.
    const inPrunedRegion = messageIndex < cutoff;
    if (!inPrunedRegion && !dedupeAcrossFullHistory) {
      return message;
    }

    // Progress notes are assistant text co-located with tool calls (narration
    // around tool orchestration). A standalone assistant text message with no
    // tool part is the user-facing answer / final summary — never pruned.
    const noteCandidate =
      inPrunedRegion && message.role === "assistant" && messageHasToolPart(message);

    let changed = false;
    const parts = message.parts.map((part, partIndex) => {
      const toolName = getToolNameFromPart(part);
      if (!toolName || getPartState(part) !== "output-available") {
        if (
          elideReasoningParts &&
          inPrunedRegion &&
          isRecord(part) &&
          Reflect.get(part, "type") === "reasoning"
        ) {
          const text = Reflect.get(part, "text");
          if (
            typeof text === "string" &&
            text !== REASONING_ELISION_STUB &&
            text.length > REASONING_ELISION_STUB.length
          ) {
            elidedReasoningParts += 1;
            savedChars += text.length - REASONING_ELISION_STUB.length;
            changed = true;
            return {
              ...(part as Record<string, unknown>),
              text: REASONING_ELISION_STUB,
            } as UIMessagePart;
          }
        }
        if (noteCandidate && toolName === null) {
          const text = getPlainTextPartContent(part);
          if (
            text !== null &&
            text !== PROGRESS_NOTE_ELISION_STUB &&
            text.length > PROGRESS_NOTE_PRUNE_MIN_CHARS
          ) {
            elidedProgressNotes += 1;
            savedChars += Math.max(
              0,
              text.length - PROGRESS_NOTE_ELISION_STUB.length,
            );
            changed = true;
            return {
              ...(part as Record<string, unknown>),
              text: PROGRESS_NOTE_ELISION_STUB,
            } as UIMessagePart;
          }
        }
        return part;
      }

      const output = isRecord(part) ? Reflect.get(part, "output") : undefined;
      if (isElidedToolOutput(output)) {
        return part;
      }

      const signature = getDedupSignature(part);
      const latestCall = signature
        ? latestCallBySignature.get(signature)
        : undefined;
      const isSuperseded = Boolean(
        latestCall &&
          !(
            latestCall.messageIndex === messageIndex &&
            latestCall.partIndex === partIndex
          ),
      );

      const serializedOutput = safeStringify(output);
      // Size-based elision stays confined to the pruned region; superseded
      // duplicates are pure waste anywhere in the history.
      const isLarge = inPrunedRegion && serializedOutput.length > minOutputChars;
      if (!isSuperseded && !isLarge) {
        return part;
      }

      const stub: ToolOutputElisionStub = {
        lightcodeElided: true,
        note: isSuperseded
          ? toolName === "read_file"
            ? "Earlier read of this file elided; its current content is already shown later in this conversation — do not read it again."
            : `Earlier identical ${toolName} call elided; its latest result appears later in this conversation — do not re-run it.`
          : "Large tool output elided to preserve context budget. Re-run the tool only if this output is needed again.",
        originalChars: serializedOutput.length,
      };

      if (isSuperseded && toolName === "read_file") {
        dedupedFileReads += 1;
      } else if (isSuperseded) {
        dedupedToolCalls += 1;
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
    dedupedToolCalls,
    elidedProgressNotes,
    elidedReasoningParts,
    savedChars,
  };
}
