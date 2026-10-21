import { isToolUIPart, type UIMessage } from "ai";

/** Tool UI states that already carry a result and are safe to send. */
const terminalToolStates = new Set([
  "output-available",
  "output-error",
  "output-denied",
]);

export const interruptedToolErrorText =
  "Tool call was interrupted by a connection retry. Re-issue the tool call if it is still needed.";

/**
 * True when any message still holds a tool call without a terminal result.
 * OpenAI- and Anthropic-compatible providers reject such histories (a
 * dangling `tool_use`/`tool_call` with no paired result) with HTTP 400.
 */
export function hasDanglingToolParts(messages: readonly UIMessage[]): boolean {
  return messages.some((message) =>
    message.parts.some(
      (part) => isToolUIPart(part) && !terminalToolStates.has(part.state),
    ),
  );
}

const unansweredApprovalDeniedReason =
  "The approval request was never answered before the turn ended. Re-issue the tool call if it is still needed.";

/**
 * Rewrites every tool call left without a terminal result to a synthesized
 * error result, so a provider never receives a dangling tool call.
 *
 * Approval states are the SDK's pause/resume mechanism for server-executed
 * tools and are NOT dangling on the trailing assistant message: the follow-up
 * request resumes from them (`approval-responded` executes the tool). Only
 * stale approval states buried mid-history — a turn that ended without the
 * approval round completing — are resolved, to `output-denied` (the provider
 * sees "the user did not approve", which is accurate) rather than an error.
 *
 * Count-preserving: only part *states* change, never the number of messages,
 * so callers that rely on the message count (e.g. the finished-message merge,
 * which slices appended messages by provider-view length) stay correct.
 */
export function resolveDanglingToolParts(
  messages: readonly UIMessage[],
  errorText = interruptedToolErrorText,
): UIMessage[] {
  const lastAssistantIndex = messages.findLastIndex(
    (message) => message.role === "assistant",
  );

  return messages.map((message, messageIndex) => {
    if (message.role !== "assistant") {
      return message as UIMessage;
    }

    const isTrailingAssistant = messageIndex === lastAssistantIndex;

    let changed = false;
    const parts = message.parts.map((part) => {
      if (!isToolUIPart(part) || terminalToolStates.has(part.state)) {
        return part;
      }

      if (
        part.state === "approval-requested" ||
        part.state === "approval-responded"
      ) {
        // Trailing approvals are live resume state — pass through untouched.
        if (isTrailingAssistant) {
          return part;
        }

        const approvalPart = part as typeof part & {
          toolCallId: string;
          approval?: { id: string; approved?: boolean; reason?: string };
        };
        changed = true;
        if (
          approvalPart.state === "approval-responded" &&
          approvalPart.approval?.approved
        ) {
          // Approved but execution never completed: an interrupted call.
          return {
            ...part,
            state: "output-error",
            errorText,
          } as unknown as typeof part;
        }
        return {
          ...part,
          state: "output-denied",
          approval: {
            ...(approvalPart.approval ?? {
              id: `${approvalPart.toolCallId}-approval`,
            }),
            approved: false,
            reason:
              approvalPart.approval?.reason ?? unansweredApprovalDeniedReason,
          },
        } as unknown as typeof part;
      }

      changed = true;
      return {
        ...part,
        state: "output-error",
        errorText,
      } as unknown as typeof part;
    });

    return changed ? ({ ...message, parts } as UIMessage) : (message as UIMessage);
  });
}

/**
 * Server-side payload guard applied to the exact provider view immediately
 * before every model call — first send, auto-continue, and retry alike.
 * Whatever code path built the view (compaction summary + tail, tier1 prune,
 * overflow recovery, or a raw history), this guarantees no dangling tool call
 * reaches the provider, which is the structural cause of "payload is not
 * correct" 400s. It is the server-side, always-on counterpart to the client's
 * retry-time `sanitizeMessagesForRetry`.
 */
export function normalizeProviderMessages(
  messages: readonly UIMessage[],
): UIMessage[] {
  return renameLegacyToolInputs(resolveDanglingToolParts(messages));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** edit_file's `replaceAll` is now `allMatches`; null when there is nothing to rename. */
function renameEditFileInput(input: unknown): Record<string, unknown> | null {
  if (!isPlainObject(input) || !("replaceAll" in input)) return null;
  const { replaceAll, ...rest } = input;
  const flag =
    replaceAll === true || replaceAll === "true"
      ? true
      : replaceAll === false || replaceAll === "false"
        ? false
        : replaceAll;
  return { ...rest, allMatches: rest.allMatches ?? flag };
}

/**
 * Rewrites edit_file calls recorded under the flag's former name. Replayed
 * as-is, a session's earlier `replaceAll` calls teach the model the old
 * spelling, and with it the `{path, replaceAll, search}` calls (no
 * `replace`) that the rename stopped (see edit-file/schema.ts).
 * Count-preserving, like resolveDanglingToolParts.
 */
export function renameLegacyToolInputs(messages: readonly UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message as UIMessage;
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool-edit_file") return part;
      const toolPart = part as typeof part & { input?: unknown; rawInput?: unknown };
      const input = renameEditFileInput(toolPart.input);
      const rawInput = renameEditFileInput(toolPart.rawInput);
      if (!input && !rawInput) return part;
      changed = true;
      return {
        ...part,
        ...(input ? { input } : {}),
        ...(rawInput ? { rawInput } : {}),
      } as typeof part;
    });
    return changed ? ({ ...message, parts } as UIMessage) : (message as UIMessage);
  });
}
