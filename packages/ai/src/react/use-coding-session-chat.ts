import { useChat } from "@ai-sdk/react";
import type { FileReferenceUIPart } from "../attachments/schema";
import {
  DefaultChatTransport,
  type FileUIPart,
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  safeValidateUIMessages,
  type UIMessage,
} from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  codingToolInputSchemas,
  evaluateCodingToolPermission,
  isServerExecutedCodingTool,
  type CodingToolInputByName,
  type CodingToolName,
  type CodingToolOutputByName,
} from "../agent-tools";
import {
  describeChatStreamError,
  parseChatStreamError,
  type ChatErrorKind,
} from "../chat-error";
import type { SessionMessagesResponse } from "../chat-schemas";
import {
  chatInteractionUpsertRequestSchema,
  chatInteractionUserPromptPayloadSchema,
  type ChatInteraction,
  type ChatInteractionListResponse,
  type ChatInteractionResolveRequest,
  type ChatInteractionUpsertRequest,
} from "../chat-interaction-schemas";
import { toSingleLinePreview } from "../common/output-utils";
import { parseCodingToolInput } from "../tool-input";
import {
  defaultCodingAgentMode,
  type CodingAgentMode,
} from "../coding-agent-modes";
import {
  type PermissionDecision,
  type PermissionMode,
  type PermissionRules,
} from "../permissions";
import type { SandboxConfig } from "../sandbox/config";
import {
  requestUserInputToolOutputSchema,
  type RequestUserInputToolOutput,
} from "../request-user-input/schema";
import type { TodoItem } from "../todo-write/schema";
import {
  decideAutoContinue,
  defaultAutoContinueLimits,
  shouldTreatAsStalled,
  type AutoContinueDecision,
  type AutoContinueKind,
} from "./auto-continue";
import { resolveDanglingToolParts } from "../context/normalize-provider-messages";
import {
  resolveCodingSessionRequestOption,
  type CodingSessionFetch,
  type CodingSessionRequestHeadersOption,
} from "./request-options";

export type ToolApprovalAction = "approve" | "deny";

type ApprovalCommandTarget = number | "all";

const recoverableDisconnectMessage =
  "Connection interrupted. Please retry or regenerate your last message.";
const buildModeAutoPromptResponse =
  "Proceed with implementation in Build mode. Continue without additional plan questions.";
const chatMessageUpdateThrottleMs = 50;
const retryCommandPattern = /^\/?(retry|regenerate)$/i;
const providerWebSearchApprovalCode =
  "provider_web_search_approval_required";
const providerWebSearchApprovalId = "lightcode-provider-web-search-approval";
const runCursorCommentPattern = /^: lightcode-cursor=(\d+)\r?$/;

export interface RunCursorScannerState {
  carry: string;
  cursor: number;
}

/** Incrementally scans SSE comment lines without modifying stream bytes. */
export function scanRunCursorText(
  state: RunCursorScannerState,
  text: string,
): RunCursorScannerState {
  const lines = `${state.carry}${text}`.split("\n");
  const carry = lines.pop() ?? "";
  let cursor = state.cursor;
  for (const line of lines) {
    const match = runCursorCommentPattern.exec(line);
    if (!match) {
      continue;
    }
    const candidate = Number(match[1]);
    if (Number.isSafeInteger(candidate) && candidate > cursor) {
      cursor = candidate;
    }
  }
  return {
    // A cursor comment is tiny. Bound malformed unterminated input so the
    // transport scanner cannot retain an unbounded server line.
    carry: carry.slice(-128),
    cursor,
  };
}

export function buildSessionRunResumeUrl({
  chatApi,
  runId,
  after,
}: {
  chatApi: string;
  runId?: string | null;
  after: number;
}): string {
  const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(chatApi);
  const url = new URL(chatApi, "http://lightcode.local");
  url.pathname = url.pathname.replace(
    /\/turns\/?$/,
    runId
      ? `/runs/${encodeURIComponent(runId)}/stream`
      : "/runs/stream",
  );
  url.search = "";
  url.searchParams.set("after", String(Math.max(-1, Math.floor(after))));
  return absolute ? url.toString() : `${url.pathname}${url.search}`;
}

const codingToolNameSet = new Set<string>(Object.keys(codingToolInputSchemas));
type CodingToolInput = CodingToolInputByName[CodingToolName];
type CodingToolOutput = CodingToolOutputByName[CodingToolName];
type RequestUserInputToolInput = CodingToolInputByName["request_user_input"];

export interface PendingToolApproval {
  toolCallId: string;
  /**
   * The SDK approval id from the `approval-requested` part. Tools execute
   * server-side; approving/denying posts this id back via
   * addToolApprovalResponse instead of executing locally.
   */
  approvalId: string;
  toolName: CodingToolName;
  input: CodingToolInput;
  summary: string;
  permissionDecision: PermissionDecision;
  cwd: string;
}

export interface PendingUserPromptOption {
  label: string;
  description?: string;
}

export interface PendingUserPrompt {
  toolCallId: string;
  header?: string;
  question: string;
  options: PendingUserPromptOption[];
  allowCustomResponse: boolean;
  placeholder?: string;
}

export interface RespondToUserPromptInput extends RequestUserInputToolOutput {
  toolCallId: string;
}

export interface AutoContinueOptions {
  enabled?: boolean;
  maxAutoContinues?: number;
  maxErrorRetries?: number;
  /** Abort + retry a streaming response after this many silent seconds. */
  stallTimeoutSeconds?: number;
}

/**
 * Why an automatic retry fired. `"stall"` is local (the stream produced no
 * bytes for stallTimeoutMs, so the upstream cause is unknown); everything else
 * is the server's classification of the failure. Lets the UI name the true
 * cause instead of always saying "Connection dropped".
 */
export type RetryReason = ChatErrorKind | "stall";

export interface AutoContinueState {
  /** Continuations sent automatically since the last user message. */
  attempt: number;
  /** What the most recent automatic action was. */
  kind: AutoContinueKind | "retry-error";
  /** Set when continuation stopped because a loop guard tripped. */
  guardTripped?: AutoContinueDecision["guardTripped"];
  /** Set when kind === "retry-error": why the retry happened. */
  retryReason?: RetryReason;
  /** Epoch ms when the scheduled retry will fire, for a live countdown. */
  retryAtMs?: number;
}

const errorRetryBaseDelayMs = 1_000;
const errorRetryMaxDelayMs = 8_000;
/**
 * Rate limits get a modestly-bounded cap so a sustained free-tier throttle can't
 * loop forever — but it must be high enough to RIDE OUT the brief 429s a paid
 * provider throws mid-task, otherwise long tasks stop early and ask the user to
 * resume. Connection drops / network errors keep the full maxErrorRetries.
 */
const rateLimitMaxRetries = 6;
/**
 * Backstop on total auto-retry wall-clock per error episode (resets on every
 * successful step). Generous so a multi-step task riding out provider blips
 * completes on its own; it only bounds a truly stuck infinite loop.
 */
const errorRetryTimeBudgetMs = 180_000;

export interface ErrorRetryDecision {
  retry: boolean;
  delayMs: number;
}

/**
 * Pure retry policy: given the next attempt number, the failure kind, how long
 * we've already spent retrying this episode, and the user's max, decide whether
 * to retry and after what backoff. Rate limits cap lower; the cumulative time
 * budget is a backstop for every kind.
 */
export function decideErrorRetry({
  attempt,
  kind,
  elapsedMs,
  maxErrorRetries,
}: {
  attempt: number;
  kind: RetryReason | undefined;
  elapsedMs: number;
  maxErrorRetries: number;
}): ErrorRetryDecision {
  const cap =
    kind === "rate_limit"
      ? Math.min(rateLimitMaxRetries, maxErrorRetries)
      : maxErrorRetries;

  if (attempt > cap) {
    return { retry: false, delayMs: 0 };
  }

  const delayMs = Math.min(
    errorRetryBaseDelayMs * 2 ** (attempt - 1),
    errorRetryMaxDelayMs,
  );

  // Stop if waiting out this backoff would blow the episode time budget.
  if (elapsedMs + delayMs > errorRetryTimeBudgetMs) {
    return { retry: false, delayMs: 0 };
  }

  return { retry: true, delayMs };
}

export interface UseCodingSessionChatOptions {
  chatApi: string;
  initialPrompt?: string;
  isSessionIdValid: boolean;
  loadPersistedMessages: () => Promise<SessionMessagesResponse>;
  loadPersistedInteractions?: () => Promise<ChatInteractionListResponse>;
  upsertInteraction?: (interaction: ChatInteractionUpsertRequest) => Promise<void>;
  resolveInteraction?: (
    toolCallId: string,
    resolution: ChatInteractionResolveRequest,
  ) => Promise<void>;
  sessionId: string;
  skipHistoryLoad?: boolean;
  /** Canonical workspace path assigned to the server-authoritative session. */
  cwd: string;
  /**
   * Optional host adapter for restoring persisted todos. Browser clients
   * should load them through the companion server; Node clients may adapt the
   * existing filesystem todo runtime.
   */
  loadTodos?: (options: {
    sessionId: string;
    cwd: string;
  }) => readonly TodoItem[] | PromiseLike<readonly TodoItem[]>;
  /** Custom fetch shared by chat submission, stream resume, and abort. */
  fetch?: CodingSessionFetch;
  /** Static or lazily refreshed headers, including browser bearer tokens. */
  headers?: CodingSessionRequestHeadersOption;
  mode?: CodingAgentMode;
  permissionMode?: PermissionMode;
  allowedTools?: readonly CodingToolName[];
  permissionRules?: PermissionRules;
  sandbox?: SandboxConfig;
  autoContinue?: AutoContinueOptions;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message;
  }

  return fallback;
}

function isCodingToolName(toolName: string): toolName is CodingToolName {
  return codingToolNameSet.has(toolName);
}

function isRequestUserInputToolName(
  toolName: CodingToolName,
): toolName is "request_user_input" {
  return toolName === "request_user_input";
}

function getStringInputProperty(input: CodingToolInput, key: string): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const value = Reflect.get(input, key);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function summarizeToolCall(toolName: CodingToolName, input: CodingToolInput): string {
  const target =
    getStringInputProperty(input, "path") ??
    getStringInputProperty(input, "command") ??
    getStringInputProperty(input, "query") ??
    getStringInputProperty(input, "pattern") ??
    getStringInputProperty(input, "revision") ??
    getStringInputProperty(input, "url");

  if (target) {
    return `${toolName} ${toSingleLinePreview(target)}`.trim();
  }

  return `${toolName} ${toSingleLinePreview(input)}`.trim();
}

function isTodoWriteOutput(
  toolName: CodingToolName,
  output: CodingToolOutput,
): output is CodingToolOutputByName["todo_write"] {
  return (
    toolName === "todo_write" &&
    typeof output === "object" &&
    output !== null &&
    Array.isArray(Reflect.get(output, "todos"))
  );
}

const disconnectErrorPattern =
  /(failed to fetch|networkerror|socket|connection|aborted|terminated|timed?\s?out|timeout|econnreset)/i;
const transientProviderErrorPattern =
  /(rate.?limit|too many requests|\b429\b|overloaded|quota)/i;

export function normalizeChatErrorMessage(message: string) {
  const structured = parseChatStreamError(message);
  if (structured) {
    // Surface the real provider error instead of a generic retry hint.
    return describeChatStreamError(structured);
  }

  if (disconnectErrorPattern.test(message)) {
    return recoverableDisconnectMessage;
  }

  return message;
}

/**
 * Transient failures (network drops, timeouts, rate limits, overload) are
 * retried automatically with backoff; only hard failures surface. The server
 * encodes its classification into the error string — trust it when present
 * and fall back to message heuristics for plain transport errors.
 */
export function isRecoverableChatErrorMessage(message: string) {
  const structured = parseChatStreamError(message);
  if (structured) {
    return structured.retryable;
  }

  return (
    disconnectErrorPattern.test(message) ||
    transientProviderErrorPattern.test(message)
  );
}

function isRetryCommand(input: string) {
  return retryCommandPattern.test(input.trim());
}

function hashTurnPayload(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}


/**
 * True for a single part that was still streaming when the turn was cut off:
 * partially-generated text/reasoning, or a tool call whose input never finished
 * arriving. Such parts are unsafe to resend and carry no completed work.
 */
function isIncompletePart(part: UIMessage["parts"][number]): boolean {
  if (
    (part.type === "text" || part.type === "reasoning") &&
    Reflect.get(part, "state") === "streaming"
  ) {
    return true;
  }

  return isToolUIPart(part) && part.state === "input-streaming";
}

/**
 * Prunes only the incomplete (still-streaming) parts from the trailing
 * assistant message(s), preserving every completed part. A multi-step agent
 * turn is a single assistant message holding all of its steps' parts, so the
 * previous behaviour — dropping the whole message when any part was mid-stream
 * — discarded every finished step (tool calls + results) of a long turn and
 * forced the model to redo the entire turn on each retry. Pruning at the part
 * level instead lets a resend resume from the last finished step.
 *
 * A trailing assistant message whose parts are *all* incomplete carries no
 * salvageable work and is dropped entirely (then the new tail is re-checked).
 */
function pruneIncompleteTrailingAssistantParts(
  messages: UIMessage[],
): UIMessage[] {
  let result = messages;

  while (result.length > 0) {
    const lastIndex = result.length - 1;
    const last = result[lastIndex];
    if (last.role !== "assistant") {
      break;
    }

    const completeParts = last.parts.filter((part) => !isIncompletePart(part));
    if (completeParts.length === last.parts.length) {
      // The trailing assistant message has no incomplete parts; nothing to do.
      break;
    }

    if (completeParts.length === 0) {
      // Nothing finished in this message; drop it and re-check the new tail.
      result = result.slice(0, lastIndex);
      continue;
    }

    const next = result.slice();
    next[lastIndex] = { ...last, parts: completeParts };
    result = next;
    break;
  }

  return result;
}

function hasUnresolvedToolParts(messages: UIMessage[]) {
  return messages.some((message) =>
    message.parts.some((part) => {
      if (!isToolUIPart(part)) {
        return false;
      }

      return ![
        "output-available",
        "output-error",
        "output-denied",
      ].includes(part.state);
    }),
  );
}

const terminalToolPartStates = new Set([
  "output-available",
  "output-error",
  "output-denied",
]);

/**
 * Counts finished units of work in a history: completed (non-streaming) text /
 * reasoning parts and tool calls that reached a terminal state. Used as a
 * monotonic forward-progress marker so repeated transport retries that produce
 * nothing new can be bounded instead of cascading forever.
 */
export function countCompletedWork(messages: UIMessage[]): number {
  let total = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (
        (part.type === "text" || part.type === "reasoning") &&
        Reflect.get(part, "state") !== "streaming"
      ) {
        total += 1;
      } else if (isToolUIPart(part) && terminalToolPartStates.has(part.state)) {
        total += 1;
      }
    }
  }
  return total;
}

/**
 * Prepares a message history for an automatic resend after an abort or
 * transport error. Trailing partially-streamed assistant messages are
 * dropped, and any tool call left without a result (e.g. aborted between
 * input-available and execution) gets a synthesized error output — providers
 * reject histories containing dangling tool calls with HTTP 400, which
 * previously turned one interrupted stream into an unrecoverable retry loop.
 *
 * Pending tool calls are never executed here: the abort may have raced an
 * actual execution, and re-running side-effectful tools (bash, edit_file)
 * silently would be worse than asking the model to re-issue the call.
 *
 * Postcondition: hasUnresolvedToolParts(result) === false.
 */
export function sanitizeMessagesForRetry(messages: UIMessage[]): UIMessage[] {
  // Zero-part assistant messages (a request that died before any part
  // streamed) fail the SDK's message schema and would poison every resend.
  const withoutEmptyAssistants = messages.filter(
    (message) => !(message.role === "assistant" && message.parts.length === 0),
  );

  // Drop only the incomplete trailing parts (preserving finished steps), then
  // resolve any remaining dangling tool call via the shared server/client
  // normalizer so retry and first-send produce identical, valid histories.
  return resolveDanglingToolParts(
    pruneIncompleteTrailingAssistantParts(withoutEmptyAssistants),
  );
}

function hasActiveClientToolWork({
  messages,
  pendingApprovals,
  pendingUserPrompts,
}: {
  messages: UIMessage[];
  pendingApprovals: PendingToolApproval[];
  pendingUserPrompts: PendingUserPrompt[];
}) {
  const pendingApprovalIds = new Set(
    pendingApprovals.map((approval) => approval.toolCallId),
  );
  const pendingPromptIds = new Set(
    pendingUserPrompts.map((prompt) => prompt.toolCallId),
  );

  return messages.some((message) =>
    message.parts.some((part) => {
      if (!isToolUIPart(part)) {
        return false;
      }

      if (part.state === "input-streaming" || part.state === "approval-responded") {
        return true;
      }

      if (part.state !== "input-available") {
        return false;
      }

      return (
        !pendingApprovalIds.has(part.toolCallId) &&
        !pendingPromptIds.has(part.toolCallId)
      );
    }),
  );
}

function parseApprovalCommand(
  input: string,
): { action: ToolApprovalAction; target: ApprovalCommandTarget } | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const commandMatch = trimmed.match(/^\/?(approve|deny)(?:\s+(all|\d+))?$/i);
  if (commandMatch) {
    const actionToken = commandMatch[1].toLowerCase();
    const action: ToolApprovalAction =
      actionToken === "approve" ? "approve" : "deny";
    const targetToken = commandMatch[2]?.toLowerCase();
    const target =
      targetToken === "all"
        ? "all"
        : targetToken
          ? Math.max(0, Number(targetToken) - 1)
          : 0;

    return {
      action,
      target,
    };
  }

  return null;
}

async function validatePersistedMessages(
  messages: SessionMessagesResponse["messages"],
): Promise<UIMessage[]> {
  const validated: UIMessage[] = [];

  for (const message of messages) {
    const result = await safeValidateUIMessages({
      messages: [message],
    });

    if (!result.success || result.data.length === 0) {
      continue;
    }

    validated.push(result.data[0]);
  }

  return validated;
}

function restorePendingUserPrompt(
  interaction: ChatInteraction,
): PendingUserPrompt | null {
  if (interaction.kind !== "user_prompt" || interaction.status !== "pending") {
    return null;
  }

  const payloadResult = chatInteractionUserPromptPayloadSchema.safeParse(
    interaction.payload,
  );
  if (!payloadResult.success) {
    return null;
  }

  return {
    toolCallId: interaction.toolCallId,
    header: payloadResult.data.header,
    question: payloadResult.data.question,
    options: payloadResult.data.options ?? [],
    allowCustomResponse: payloadResult.data.allowCustomResponse,
    placeholder: payloadResult.data.placeholder,
  };
}

export function useCodingSessionChat({
  chatApi,
  initialPrompt = "",
  isSessionIdValid,
  loadPersistedMessages,
  loadPersistedInteractions,
  upsertInteraction,
  resolveInteraction,
  sessionId,
  skipHistoryLoad = false,
  cwd,
  loadTodos,
  fetch: requestFetch,
  headers: requestHeaders,
  mode = defaultCodingAgentMode,
  permissionMode,
  allowedTools,
  permissionRules,
  sandbox,
  autoContinue,
}: UseCodingSessionChatOptions) {
  const submittedInitialPromptRef = useRef<string | null>(null);
  // Groups file edits by user turn so /undo can revert one turn at a time.
  const turnCounterRef = useRef(0);
  const turnKeyRef = useRef(`turn-${Date.now()}-0`);
  const modeRef = useRef(mode);
  const cwdRef = useRef(cwd);
  const permissionModeRef = useRef(permissionMode);
  const allowedToolsRef = useRef(allowedTools);
  const permissionRulesRef = useRef(permissionRules);
  const sandboxRef = useRef(sandbox);
  const requestFetchRef = useRef(requestFetch);
  const requestHeadersRef = useRef(requestHeaders);
  const sessionRevisionRef = useRef(0);
  const activeRunIdRef = useRef<string | null>(null);
  const runCursorRef = useRef(-1);
  const resumedSessionRef = useRef<string | null>(null);
  const canonicalSyncPromiseRef = useRef<Promise<void> | null>(null);
  const refreshPersistedMessagesRef = useRef<() => Promise<void>>(
    async () => undefined,
  );
  const providerWebSearchDecisionRef = useRef<
    "approved" | "denied" | undefined
  >(undefined);
  const providerWebSearchApprovalRef = useRef<PendingToolApproval | null>(null);
  const loadPersistedMessagesRef = useRef(loadPersistedMessages);
  const loadPersistedInteractionsRef = useRef(loadPersistedInteractions);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [toolExecutionError, setToolExecutionError] = useState<string | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(true);
  const [isHistoryResumePending, setIsHistoryResumePending] = useState(true);
  const [isCanonicalSyncing, setIsCanonicalSyncing] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<PendingToolApproval[]>([]);
  const [pendingUserPrompts, setPendingUserPrompts] = useState<PendingUserPrompt[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [autoContinueState, setAutoContinueState] =
    useState<AutoContinueState | null>(null);

  const autoContinueLimits = {
    enabled: autoContinue?.enabled ?? defaultAutoContinueLimits.enabled,
    maxAutoContinues:
      autoContinue?.maxAutoContinues ?? defaultAutoContinueLimits.maxAutoContinues,
  };
  const maxErrorRetries = autoContinue?.maxErrorRetries ?? 5;
  // 180s of *byte* silence (heartbeats arrive every 15s while the server is
  // healthy) means the connection is genuinely dead, not a slow model.
  const stallTimeoutMs = (autoContinue?.stallTimeoutSeconds ?? 180) * 1_000;
  const autoContinueLimitsRef = useRef(autoContinueLimits);
  autoContinueLimitsRef.current = autoContinueLimits;
  const maxErrorRetriesRef = useRef(maxErrorRetries);
  maxErrorRetriesRef.current = maxErrorRetries;
  // Let a full error episode play out (maxErrorRetries), plus a small
  // cross-episode budget, before declaring the task stuck with no new work.
  const maxNoProgressRetries = maxErrorRetries + 3;
  const maxNoProgressRetriesRef = useRef(maxNoProgressRetries);
  maxNoProgressRetriesRef.current = maxNoProgressRetries;
  const stallTimeoutMsRef = useRef(stallTimeoutMs);
  stallTimeoutMsRef.current = stallTimeoutMs;
  // Timestamp of the most recent streaming activity (any messages update).
  const lastStreamActivityRef = useRef(Date.now());
  // Guards against the error-retry effect double-firing during a stall abort.
  const stallRecoveryInFlightRef = useRef(false);
  // Continuations/nudges sent since the last real user message.
  const autoContinuesRef = useRef(0);
  // Transport-error retries in the current error episode.
  const errorRetriesRef = useRef(0);
  const errorRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When the current error episode began, for the cumulative retry-time budget.
  const errorEpisodeStartRef = useRef<number | null>(null);
  // Message id of the assistant response we already decided on, so the
  // ready-state effect fires once per response.
  const lastDecidedAssistantIdRef = useRef<string | null>(null);
  // Forward-progress guard: bounds retries that add no finished work so a
  // provider that keeps dropping mid-stream cannot cascade indefinitely. The
  // per-episode error cap resets on every "ready", so this cross-episode
  // marker is what actually stops the loop.
  const lastProgressMarkerRef = useRef(0);
  const noProgressRetriesRef = useRef(0);
  // Latched once the task is declared stuck; halts auto-retry and
  // auto-continue until the user sends a new message.
  const taskStuckRef = useRef(false);
  // Latest messages, mirrored for the stall watchdog, which cannot depend on
  // `messages` without resetting its interval on every streamed chunk.
  const messagesRef = useRef<UIMessage[]>([]);

  const advanceTurnKey = useCallback(() => {
    turnCounterRef.current += 1;
    turnKeyRef.current = `turn-${Date.now()}-${turnCounterRef.current}`;
    autoContinuesRef.current = 0;
    errorRetriesRef.current = 0;
    errorEpisodeStartRef.current = null;
    lastProgressMarkerRef.current = 0;
    noProgressRetriesRef.current = 0;
    taskStuckRef.current = false;
    lastDecidedAssistantIdRef.current = null;
    providerWebSearchDecisionRef.current = undefined;
    providerWebSearchApprovalRef.current = null;
    setPendingApprovals((current) =>
      current.filter(
        (approval) => approval.approvalId !== providerWebSearchApprovalId,
      ),
    );
    if (errorRetryTimerRef.current) {
      clearTimeout(errorRetryTimerRef.current);
      errorRetryTimerRef.current = null;
    }
    setAutoContinueState(null);
  }, []);

  // Records a retry attempt and reports whether the agent may keep retrying.
  // Returns false once too many consecutive retries have produced no newly
  // finished work, which latches the stuck guard.
  const registerRetryProgress = useCallback((currentMessages: UIMessage[]) => {
    const marker = countCompletedWork(currentMessages);
    if (marker > lastProgressMarkerRef.current) {
      lastProgressMarkerRef.current = marker;
      noProgressRetriesRef.current = 0;
      return true;
    }
    noProgressRetriesRef.current += 1;
    if (noProgressRetriesRef.current > maxNoProgressRetriesRef.current) {
      taskStuckRef.current = true;
      return false;
    }
    return true;
  }, []);

  modeRef.current = mode;
  cwdRef.current = cwd;
  permissionModeRef.current = permissionMode;
  allowedToolsRef.current = allowedTools;
  permissionRulesRef.current = permissionRules;
  sandboxRef.current = sandbox;
  requestFetchRef.current = requestFetch;
  requestHeadersRef.current = requestHeaders;
  loadPersistedMessagesRef.current = loadPersistedMessages;
  loadPersistedInteractionsRef.current = loadPersistedInteractions;

  const syncCanonicalHistory = useCallback((): Promise<void> => {
    const current = canonicalSyncPromiseRef.current;
    if (current) {
      return current;
    }

    setIsCanonicalSyncing(true);
    const synchronization = refreshPersistedMessagesRef.current().finally(() => {
      if (canonicalSyncPromiseRef.current === synchronization) {
        canonicalSyncPromiseRef.current = null;
      }
      setIsCanonicalSyncing(false);
    });
    canonicalSyncPromiseRef.current = synchronization;
    return synchronization;
  }, []);

  const transport = useMemo(() => {
    // Stall detection must observe transport bytes, not React state updates:
    // server heartbeats and reasoning deltas prove the connection is alive
    // even when nothing user-visible renders for minutes.
    const monitoredFetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const method = init?.method?.toUpperCase() ?? "GET";
      if (method === "POST") {
        // A newly admitted turn owns a fresh cursor sequence. A 428 preflight
        // has no run and leaves both refs empty until its approved resend.
        activeRunIdRef.current = null;
        runCursorRef.current = -1;
      }
      const response = await (requestFetchRef.current ?? globalThis.fetch)(
        input,
        init,
      );
      const revisionHeader = response.headers.get("x-lightcode-revision");
      if (revisionHeader) {
        const revision = Number(revisionHeader);
        if (Number.isInteger(revision) && revision >= 0) {
          sessionRevisionRef.current = revision;
        }
      }
      const responseRunId = response.headers.get("x-lightcode-run-id");
      if (responseRunId) {
        if (responseRunId !== activeRunIdRef.current) {
          runCursorRef.current = -1;
        }
        activeRunIdRef.current = responseRunId;
      } else if (method === "GET" && response.status === 204) {
        activeRunIdRef.current = null;
        runCursorRef.current = -1;
      }

      // Provider-native search executes inside the provider request, before a
      // normal tool-call approval can be returned. The server therefore stops
      // the admission preflight with 428 and no side effects. Surface that as
      // the same approval card used by ordinary tools; approve/deny resends the
      // unchanged turn with an explicit pre-turn decision.
      if (response.status === 428) {
        try {
          const payload = (await response.clone().json()) as unknown;
          if (
            typeof payload === "object" &&
            payload !== null &&
            Reflect.get(payload, "code") === providerWebSearchApprovalCode
          ) {
            const input = {
              query: "Allow provider-native web search for this turn",
              provider: "auto" as const,
              maxResults: 3,
            };
            const approval: PendingToolApproval = {
              toolCallId: providerWebSearchApprovalId,
              approvalId: providerWebSearchApprovalId,
              toolName: "web_search",
              input,
              summary: "Use provider-native web search during this turn.",
              permissionDecision: evaluateCodingToolPermission({
                toolName: "web_search",
                input,
                mode: modeRef.current ?? defaultCodingAgentMode,
                permissionMode: permissionModeRef.current,
                allowedTools: allowedToolsRef.current,
                permissionRules: permissionRulesRef.current,
              }),
              cwd: cwdRef.current,
            };
            providerWebSearchApprovalRef.current = approval;
            setPendingApprovals((current) => [
              approval,
              ...current.filter(
                (item) => item.approvalId !== providerWebSearchApprovalId,
              ),
            ]);
          }
        } catch {
          // Leave malformed 428 responses to the normal transport error path.
        }
      }
      lastStreamActivityRef.current = Date.now();

      if (!response.body) {
        return response;
      }

      const cursorDecoder = new TextDecoder();
      let cursorState: RunCursorScannerState = {
        carry: "",
        cursor: runCursorRef.current,
      };
      const monitoredBody = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            lastStreamActivityRef.current = Date.now();
            cursorState = scanRunCursorText(
              cursorState,
              cursorDecoder.decode(chunk, { stream: true }),
            );
            runCursorRef.current = cursorState.cursor;
            controller.enqueue(chunk);
          },
          flush() {
            cursorState = scanRunCursorText(
              cursorState,
              cursorDecoder.decode(),
            );
            runCursorRef.current = cursorState.cursor;
          },
        }),
      );

      return new Response(monitoredBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }) as typeof globalThis.fetch;

    return new DefaultChatTransport({
      api: chatApi,
      fetch: monitoredFetch,
      headers: async () =>
        (await resolveCodingSessionRequestOption(requestHeadersRef.current)) ??
        {},
      body: () => ({
        mode: modeRef.current,
        permissionMode: permissionModeRef.current,
        allowedTools: allowedToolsRef.current,
        permissionRules: permissionRulesRef.current,
        sandbox: sandboxRef.current,
      }),
      prepareSendMessagesRequest: async ({ messages, body, trigger }) => {
        // SDK-internal auto-sends run immediately after onFinish. Wait for the
        // canonical revision/message replacement started there before forming
        // a new idempotency key or expectedRevision.
        await canonicalSyncPromiseRef.current;
        const message = messages.at(-1);
        if (!message || (message.role !== "user" && message.role !== "assistant")) {
          throw new Error("No admissible turn message is available to send.");
        }
        const expectedRevision = sessionRevisionRef.current;
        return {
          body: {
            ...body,
            clientTurnId: `${message.id}:${expectedRevision}:${hashTurnPayload({
              parts: message.parts,
              metadata: message.metadata,
              trigger,
            })}`,
            expectedRevision,
            messageId: message.id,
            role: message.role,
            parts: message.parts,
            metadata: message.metadata,
            trigger,
            providerWebSearchDecision:
              providerWebSearchDecisionRef.current,
          },
        };
      },
      prepareReconnectToStreamRequest: () => ({
        api: buildSessionRunResumeUrl({
          chatApi,
          runId: activeRunIdRef.current,
          after: runCursorRef.current,
        }),
      }),
    });
  }, [chatApi]);

  const checkpointInteraction = useCallback(
    async (interaction: ChatInteractionUpsertRequest) => {
      if (!upsertInteraction) {
        return;
      }

      try {
        await upsertInteraction(interaction);
      } catch (interactionError) {
        console.warn("Failed to checkpoint chat interaction.", interactionError);
      }
    },
    [upsertInteraction],
  );

  const markInteractionResolved = useCallback(
    async (toolCallId: string, resolution: ChatInteractionResolveRequest) => {
      if (!resolveInteraction) {
        return;
      }

      try {
        await resolveInteraction(toolCallId, resolution);
      } catch (interactionError) {
        console.warn("Failed to resolve chat interaction.", interactionError);
      }
    },
    [resolveInteraction],
  );

  // Delivery failures for prompt answers must be visible, not console noise:
  // a lost answer leaves the model waiting on a tool result forever, and the
  // user needs to know the turn dead-ended rather than watch it idle.
  const queueToolOutput = useCallback(
    (outputResult: void | PromiseLike<void>) => {
      if (!outputResult) {
        return;
      }

      void Promise.resolve(outputResult).catch((outputError) => {
        setToolExecutionError(
          getErrorMessage(
            outputError,
            "Failed to deliver the tool response to the model. Retry or resend your message.",
          ),
        );
      });
    },
    [],
  );

  const {
    messages,
    setMessages,
    sendMessage,
    addToolOutput,
    addToolApprovalResponse,
    clearError,
    error,
    resumeStream,
    status,
    stop,
  } =
    useChat<UIMessage>({
      id: sessionId,
      transport,
      experimental_throttle: chatMessageUpdateThrottleMs,
      // Tool results and approval responses both complete a turn: results
      // arrive in-stream from the server loop; approval responses are posted
      // by the client and must auto-resend so the server executes the tool.
      sendAutomaticallyWhen: (options) =>
        lastAssistantMessageIsCompleteWithToolCalls(options) ||
        lastAssistantMessageIsCompleteWithApprovalResponses(options),
      onFinish: ({ isAbort, isDisconnect }) => {
        if (isAbort || isDisconnect) {
          return;
        }
        // The resumable SSE closes only after run_finished is durable and the
        // run row is terminal, so this loads the authoritative final revision.
        void syncCanonicalHistory();
      },
      onToolCall: async ({ toolCall }) => {
        if (toolCall.dynamic || !isCodingToolName(toolCall.toolName)) {
          return;
        }

        // Every tool except request_user_input executes inside the server
        // loop; output (or an approval request) arrives in-stream, so the
        // client must not execute or answer.
        if (isServerExecutedCodingTool(toolCall.toolName)) {
          return;
        }

        const toolName = toolCall.toolName;
        if (!isRequestUserInputToolName(toolName)) {
          return;
        }

        let promptInput: RequestUserInputToolInput;
        try {
          promptInput = parseCodingToolInput(
            "request_user_input",
            toolCall.input,
          );
        } catch (toolError) {
          queueToolOutput(
            addToolOutput({
              tool: toolName,
              toolCallId: toolCall.toolCallId,
              state: "output-error",
              errorText: getErrorMessage(toolError, "Invalid tool input payload."),
            }),
          );
          return;
        }

        if (mode !== "plan") {
          queueToolOutput(
            addToolOutput({
              tool: "request_user_input",
              toolCallId: toolCall.toolCallId,
              output: {
                answer: buildModeAutoPromptResponse,
                source: "custom",
              },
            }),
          );
          return;
        }

        const pendingPrompt: PendingUserPrompt = {
          toolCallId: toolCall.toolCallId,
          header: promptInput.header,
          question: promptInput.question,
          options: promptInput.options ?? [],
          allowCustomResponse: promptInput.allowCustomResponse,
          placeholder: promptInput.placeholder,
        };

        void checkpointInteraction(
          chatInteractionUpsertRequestSchema.parse({
            kind: "user_prompt",
            toolCallId: toolCall.toolCallId,
            payload: promptInput,
          }),
        );

        setPendingUserPrompts((current) => {
          if (current.some((item) => item.toolCallId === toolCall.toolCallId)) {
            return current;
          }

          return [...current, pendingPrompt];
        });
      },
    });

  const setMessagesRef = useRef(setMessages);
  setMessagesRef.current = setMessages;

  const resumeAuthoritativeRun = useCallback(async () => {
    clearError();
    setToolExecutionError(null);
    await resumeStream();

    // A 204 discovery response means no run remains to follow and does not
    // invoke the SDK onFinish callback. Re-sync explicitly in that case.
    if (!activeRunIdRef.current) {
      await syncCanonicalHistory();
    } else if (canonicalSyncPromiseRef.current) {
      await canonicalSyncPromiseRef.current;
    }
  }, [clearError, resumeStream, syncCanonicalHistory]);

  // Approvals are derived from the stream: server-executed tools pause with an
  // `approval-requested` part and resume when the client posts the response.
  // Deriving from message parts (instead of accumulating in onToolCall) makes
  // reload/resume free — persisted histories carry the parts.
  const checkpointedApprovalIdsRef = useRef(new Set<string>());
  useEffect(() => {
    const derived: PendingToolApproval[] = [];
    for (const message of messages) {
      if (message.role !== "assistant") {
        continue;
      }
      for (const part of message.parts) {
        if (!isToolUIPart(part) || part.state !== "approval-requested") {
          continue;
        }
        const toolName = getToolName(part);
        if (!isCodingToolName(toolName)) {
          continue;
        }
        const approvalId = (part as { approval?: { id?: string } }).approval?.id;
        if (!approvalId) {
          continue;
        }

        let parsedInput: CodingToolInput;
        try {
          parsedInput = parseCodingToolInput(toolName, part.input);
        } catch {
          continue;
        }

        derived.push({
          toolCallId: part.toolCallId,
          approvalId,
          toolName,
          input: parsedInput,
          summary: summarizeToolCall(toolName, parsedInput),
          // Display-only: the server made the same decision to raise the
          // approval; recompute so the card can show what rule tripped.
          permissionDecision: evaluateCodingToolPermission({
            toolName,
            input: parsedInput,
            mode,
            permissionMode,
            allowedTools,
            permissionRules,
          }),
          cwd,
        });
      }
    }

    const providerApproval = providerWebSearchApprovalRef.current;
    const nextApprovals = providerApproval
      ? [providerApproval, ...derived]
      : derived;
    setPendingApprovals((current) => {
      if (
        current.length === nextApprovals.length &&
        current.every(
          (item, index) =>
            item.toolCallId === nextApprovals[index].toolCallId,
        )
      ) {
        return current;
      }
      return nextApprovals;
    });

    // Checkpoint each approval once: pending interactions block compaction
    // server-side, so the approval part can never be summarized away.
    for (const approval of derived) {
      if (checkpointedApprovalIdsRef.current.has(approval.toolCallId)) {
        continue;
      }
      checkpointedApprovalIdsRef.current.add(approval.toolCallId);
      void checkpointInteraction(
        chatInteractionUpsertRequestSchema.parse({
          kind: "tool_approval",
          toolCallId: approval.toolCallId,
          payload: {
            toolName: approval.toolName,
            input: approval.input,
            summary: approval.summary,
            permissionDecision: approval.permissionDecision,
            cwd,
          },
        }),
      );
    }
  }, [
    allowedTools,
    checkpointInteraction,
    cwd,
    messages,
    mode,
    permissionMode,
    permissionRules,
  ]);

  // todo_write executes server-side now; mirror the latest streamed output
  // into the session todo panel.
  useEffect(() => {
    for (let m = messages.length - 1; m >= 0; m -= 1) {
      const message = messages[m];
      if (message.role !== "assistant") {
        continue;
      }
      for (let p = message.parts.length - 1; p >= 0; p -= 1) {
        const part = message.parts[p];
        if (
          !isToolUIPart(part) ||
          part.state !== "output-available" ||
          getToolName(part) !== "todo_write"
        ) {
          continue;
        }
        const output = part.output as CodingToolOutput;
        if (isTodoWriteOutput("todo_write", output)) {
          setTodos(output.todos);
        }
        return;
      }
    }
  }, [messages]);

  const resolveToolApproval = useCallback(
    (action: ToolApprovalAction, index: number) => {
      if (pendingApprovals.length === 0) {
        setToolExecutionError("No pending tool approvals.");
        return;
      }

      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= pendingApprovals.length
      ) {
        setToolExecutionError(
          `Invalid approval index. Use 1-${pendingApprovals.length}.`,
        );
        return;
      }

      const selectedApproval = pendingApprovals[index];
      // Optimistic removal for immediate feedback; the derived effect
      // reconciles from message parts once the SDK records the response.
      setPendingApprovals((current) =>
        current.filter((item) => item.toolCallId !== selectedApproval.toolCallId),
      );
      setToolExecutionError(null);

      if (selectedApproval.approvalId === providerWebSearchApprovalId) {
        providerWebSearchApprovalRef.current = null;
        providerWebSearchDecisionRef.current =
          action === "approve" ? "approved" : "denied";
        clearError();
        // The 428 preflight persisted neither a run nor a message. Resending
        // the same local turn is therefore idempotent and now carries the
        // explicit decision the server requires.
        void sendMessage();
        return;
      }

      // The tool executes server-side: post the approval response and let the
      // auto-resend continue the loop. Denials stream back as output-denied.
      void addToolApprovalResponse({
        id: selectedApproval.approvalId,
        approved: action === "approve",
        ...(action === "deny"
          ? { reason: "Tool execution denied by user." }
          : {}),
      });
      void markInteractionResolved(selectedApproval.toolCallId, {
        status: action === "approve" ? "approved" : "denied",
        response:
          action === "deny"
            ? { errorText: "Tool execution denied by user." }
            : undefined,
      });
    },
    [
      addToolApprovalResponse,
      clearError,
      markInteractionResolved,
      pendingApprovals,
      sendMessage,
    ],
  );

  const resolveAllToolApprovals = useCallback(
    (action: ToolApprovalAction) => {
      if (pendingApprovals.length === 0) {
        setToolExecutionError("No pending tool approvals.");
        return;
      }

      const selectedApprovals = [...pendingApprovals];
      setPendingApprovals([]);
      setToolExecutionError(null);

      const providerApproval = selectedApprovals.find(
        (approval) => approval.approvalId === providerWebSearchApprovalId,
      );
      if (providerApproval) {
        providerWebSearchApprovalRef.current = null;
        providerWebSearchDecisionRef.current =
          action === "approve" ? "approved" : "denied";
      }

      // Responses are instant (no local execution): post them all, then the
      // auto-resend fires once every request has an answer and the server
      // executes the approved tools inside one continued loop.
      for (const approval of selectedApprovals) {
        if (approval.approvalId === providerWebSearchApprovalId) {
          continue;
        }
        void addToolApprovalResponse({
          id: approval.approvalId,
          approved: action === "approve",
          ...(action === "deny"
            ? { reason: "Tool execution denied by user." }
            : {}),
        });
        void markInteractionResolved(approval.toolCallId, {
          status: action === "approve" ? "approved" : "denied",
          response:
            action === "deny"
              ? { errorText: "Tool execution denied by user." }
              : undefined,
          });
      }

      if (providerApproval) {
        clearError();
        void sendMessage();
      }
    },
    [
      addToolApprovalResponse,
      clearError,
      markInteractionResolved,
      pendingApprovals,
      sendMessage,
    ],
  );

  const respondToUserPrompt = useCallback(
    ({ toolCallId, ...rawResponse }: RespondToUserPromptInput) => {
      const pendingPrompt = pendingUserPrompts.find(
        (prompt) => prompt.toolCallId === toolCallId,
      );

      if (!pendingPrompt) {
        setToolExecutionError("No matching user prompt is pending.");
        return;
      }

      const parsedResponse = requestUserInputToolOutputSchema.safeParse(rawResponse);
      if (!parsedResponse.success) {
        setToolExecutionError("Invalid user prompt response.");
        return;
      }

      setToolExecutionError(null);
      setPendingUserPrompts((current) =>
        current.filter((prompt) => prompt.toolCallId !== toolCallId),
      );
      queueToolOutput(
        (async () => {
          await addToolOutput({
            tool: "request_user_input",
            toolCallId,
            output: parsedResponse.data,
          });
          await markInteractionResolved(toolCallId, {
            status: "answered",
            response: parsedResponse.data,
          });
        })(),
      );
    },
    [addToolOutput, markInteractionResolved, pendingUserPrompts, queueToolOutput],
  );

  const canRetryRecoverableResponse = Boolean(
    error?.message && isRecoverableChatErrorMessage(error.message),
  );

  const retryRecoverableResponse = useCallback(async () => {
    if (!error?.message || !isRecoverableChatErrorMessage(error.message)) {
      setToolExecutionError("No recoverable response is waiting to retry.");
      return;
    }

    if (pendingApprovals.length > 0 || pendingUserPrompts.length > 0) {
      setToolExecutionError(
        "Resolve pending tool approvals or user prompts before retrying.",
      );
      return;
    }

    await resumeAuthoritativeRun();
  }, [
    error?.message,
    pendingApprovals.length,
    pendingUserPrompts.length,
    resumeAuthoritativeRun,
  ]);

  // The error episode is over only when a response actually completes.
  // Resetting as soon as a retry briefly reaches "streaming" used to defeat
  // the retry cap and allow an infinite abort/resend loop.
  useEffect(() => {
    if (status === "ready" && !error) {
      errorRetriesRef.current = 0;
      errorEpisodeStartRef.current = null;
    }
  }, [error, status]);

  // Any messages update while a request is active counts as stream activity.
  useEffect(() => {
    if (status === "streaming" || status === "submitted") {
      lastStreamActivityRef.current = Date.now();
    }
  }, [messages, status]);

  // Mirror the latest messages so the stall watchdog can read them without
  // taking a `messages` dependency (which would reset its interval per chunk).
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Stall watchdog: a request that produces no chunks for stallTimeoutMs is
  // dead (provider/network hang) — abort it and retry automatically instead
  // of waiting minutes for a fetch timeout.
  useEffect(() => {
    if (status !== "streaming" && status !== "submitted") {
      return;
    }

    const intervalId = setInterval(() => {
      if (
        !shouldTreatAsStalled({
          lastActivityAt: lastStreamActivityRef.current,
          now: Date.now(),
          stallTimeoutMs: stallTimeoutMsRef.current,
        })
      ) {
        return;
      }

      if (
        taskStuckRef.current ||
        stallRecoveryInFlightRef.current ||
        errorRetriesRef.current >= maxErrorRetriesRef.current
      ) {
        return;
      }

      // Stop retrying a connection that keeps dying without producing new work.
      if (!registerRetryProgress(messagesRef.current)) {
        setAutoContinueState({
          attempt: errorRetriesRef.current,
          kind: "none",
          guardTripped: "no-progress",
        });
        return;
      }

      stallRecoveryInFlightRef.current = true;
      errorRetriesRef.current += 1;
      // The watchdog fires on no bytes, not on a classified error, so the
      // upstream cause is genuinely unknown here.
      setAutoContinueState({
        attempt: errorRetriesRef.current,
        kind: "retry-error",
        retryReason: "stall",
      });

      void (async () => {
        try {
          await stop();
          await resumeAuthoritativeRun();
        } finally {
          stallRecoveryInFlightRef.current = false;
        }
      })();
    }, 15_000);

    return () => clearInterval(intervalId);
  }, [registerRetryProgress, resumeAuthoritativeRun, status, stop]);

  // Fully automatic continuation: when a response ends but the task is not
  // done (output truncated, unparsed tool intent, unfinished todos, or text
  // that announces more work), keep the agent going without user action.
  useEffect(() => {
    if (status !== "ready" || error) {
      return;
    }

    if (
      taskStuckRef.current ||
      isHistoryLoading ||
      isHistoryResumePending ||
      isCanonicalSyncing ||
      canonicalSyncPromiseRef.current !== null ||
      pendingApprovals.length > 0 ||
      pendingUserPrompts.length > 0 ||
      hasUnresolvedToolParts(messages)
    ) {
      return;
    }

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") {
      return;
    }

    if (lastDecidedAssistantIdRef.current === lastMessage.id) {
      return;
    }
    lastDecidedAssistantIdRef.current = lastMessage.id;

    const decision = decideAutoContinue({
      messages,
      todos,
      autoContinuesThisTurn: autoContinuesRef.current,
      limits: autoContinueLimitsRef.current,
    });

    if (decision.guardTripped) {
      setAutoContinueState({
        attempt: autoContinuesRef.current,
        kind: "none",
        guardTripped: decision.guardTripped,
      });
      return;
    }

    if (decision.kind === "none" || !decision.prompt) {
      setAutoContinueState(null);
      return;
    }

    autoContinuesRef.current += 1;
    setAutoContinueState({
      attempt: autoContinuesRef.current,
      kind: decision.kind,
    });
    void sendMessage({
      text: decision.prompt,
      metadata: { autoContinue: true },
    });
  }, [
    error,
    isCanonicalSyncing,
    isHistoryLoading,
    isHistoryResumePending,
    messages,
    pendingApprovals.length,
    pendingUserPrompts.length,
    sendMessage,
    status,
    todos,
  ]);

  // Recoverable transport errors retry automatically with backoff; the user
  // never has to type /retry.
  useEffect(() => {
    if (!error?.message || !isRecoverableChatErrorMessage(error.message)) {
      return;
    }

    if (
      taskStuckRef.current ||
      pendingApprovals.length > 0 ||
      pendingUserPrompts.length > 0 ||
      errorRetryTimerRef.current ||
      stallRecoveryInFlightRef.current
    ) {
      return;
    }

    // The server already classified the failure; surface its real cause instead
    // of always saying "Connection dropped". Plain transport errors with no
    // structured envelope fall back to "network".
    const retryReason: RetryReason =
      parseChatStreamError(error.message)?.kind ?? "network";

    if (errorEpisodeStartRef.current === null) {
      errorEpisodeStartRef.current = Date.now();
    }
    const attempt = errorRetriesRef.current + 1;
    const decision = decideErrorRetry({
      attempt,
      kind: retryReason,
      elapsedMs: Date.now() - errorEpisodeStartRef.current,
      maxErrorRetries: maxErrorRetriesRef.current,
    });

    // Give up auto-retrying (rate-limit cap or time budget hit): leave the error
    // surfaced so the user can act. Nothing is lost — full history is persisted.
    if (!decision.retry) {
      return;
    }

    const delay = decision.delayMs;
    // Show the wait immediately with a deadline so the UI can count down rather
    // than appear frozen during backoff.
    setAutoContinueState({
      attempt,
      kind: "retry-error",
      retryReason,
      retryAtMs: Date.now() + delay,
    });

    errorRetryTimerRef.current = setTimeout(() => {
      errorRetryTimerRef.current = null;
      // Evaluate progress when the retry actually fires (once per attempt),
      // not at schedule time, which can run repeatedly as deps change.
      if (!registerRetryProgress(messagesRef.current)) {
        setAutoContinueState({
          attempt: errorRetriesRef.current,
          kind: "none",
          guardTripped: "no-progress",
        });
        return;
      }
      errorRetriesRef.current = attempt;
      setAutoContinueState({ attempt, kind: "retry-error", retryReason });
      void resumeAuthoritativeRun();
    }, delay);

    return () => {
      if (errorRetryTimerRef.current) {
        clearTimeout(errorRetryTimerRef.current);
        errorRetryTimerRef.current = null;
      }
    };
  }, [
    error?.message,
    pendingApprovals.length,
    pendingUserPrompts.length,
    registerRetryProgress,
    resumeAuthoritativeRun,
  ]);

  const submitInput = useCallback(
    (
      text: string,
      files?: FileUIPart[],
      referenceParts: FileReferenceUIPart[] = [],
    ) => {
      if (canRetryRecoverableResponse && isRetryCommand(text)) {
        void retryRecoverableResponse();
        return;
      }

      if (pendingApprovals.length > 0) {
        const approvalCommand = parseApprovalCommand(text);
        if (approvalCommand) {
          if (approvalCommand.target === "all") {
            resolveAllToolApprovals(approvalCommand.action);
          } else {
            resolveToolApproval(approvalCommand.action, approvalCommand.target);
          }
          return;
        }

        setToolExecutionError(
          "Tool approval pending. Use approve/deny with optional index or all, e.g. 'approve 1' or 'approve all'.",
        );
        return;
      }

      if (pendingUserPrompts.length > 0) {
        setToolExecutionError(
          "A user prompt is waiting for response. Please answer it in the inline prompt.",
        );
        return;
      }

      setToolExecutionError(null);
      advanceTurnKey();
      if (referenceParts.length > 0) {
        void sendMessage({
          parts: [
            ...(files ?? []),
            ...referenceParts,
            { type: "text", text },
          ],
        });
      } else {
        void sendMessage({ text, files });
      }
    },
    [
      advanceTurnKey,
      pendingApprovals.length,
      pendingUserPrompts.length,
      canRetryRecoverableResponse,
      retryRecoverableResponse,
      resolveAllToolApprovals,
      resolveToolApproval,
      sendMessage,
    ],
  );

  const sendDirectMessage = useCallback(
    (text: string) => {
      const messageText = text.trim();
      if (!messageText) {
        return;
      }

      setToolExecutionError(null);
      advanceTurnKey();
      void sendMessage({ text: messageText });
    },
    [advanceTurnKey, sendMessage],
  );

  /** Reload canonical server history after an out-of-band session action. */
  const refreshPersistedMessages = useCallback(async () => {
    const messagePayload = await loadPersistedMessagesRef.current();
    sessionRevisionRef.current = messagePayload.session?.revision ?? 0;
    const validatedMessages = await validatePersistedMessages(
      messagePayload.messages,
    );

    setMessagesRef.current(
      pruneIncompleteTrailingAssistantParts(validatedMessages),
    );
    setPendingApprovals([]);
    setPendingUserPrompts([]);
    setHistoryError(null);
    setToolExecutionError(null);
    activeRunIdRef.current = null;
    runCursorRef.current = -1;
  }, []);
  refreshPersistedMessagesRef.current = refreshPersistedMessages;

  useEffect(() => {
    let cancelled = false;
    sessionRevisionRef.current = 0;
    activeRunIdRef.current = null;
    runCursorRef.current = -1;
    resumedSessionRef.current = null;
    providerWebSearchDecisionRef.current = undefined;
    providerWebSearchApprovalRef.current = null;
    submittedInitialPromptRef.current = null;
    setHistoryError(null);
    setToolExecutionError(null);
    setPendingApprovals([]);
    setPendingUserPrompts([]);
    setIsHistoryLoading(true);
    setIsHistoryResumePending(true);

    async function loadMessages() {
      if (!isSessionIdValid) {
        setMessagesRef.current([]);
        setHistoryError("Invalid session route.");
        setIsHistoryLoading(false);
        return;
      }

      if (skipHistoryLoad) {
        setMessagesRef.current([]);
        setIsHistoryLoading(false);
        return;
      }

      try {
        const [messagePayload, interactionPayload] = await Promise.all([
          loadPersistedMessagesRef.current(),
          loadPersistedInteractionsRef.current
            ? loadPersistedInteractionsRef.current()
            : Promise.resolve({ interactions: [] }),
        ]);
        sessionRevisionRef.current = messagePayload.session?.revision ?? 0;
        const validatedMessages = await validatePersistedMessages(
          messagePayload.messages,
        );
        // Approvals restore from the persisted approval-requested parts (the
        // derived effect picks them up); only user prompts still need the
        // interaction store, since their tool calls carry no approval state.
        const restoredPrompts = interactionPayload.interactions
          .map(restorePendingUserPrompt)
          .filter((prompt): prompt is PendingUserPrompt => prompt !== null);

        if (cancelled) {
          return;
        }

        // A session that crashed mid-stream may end with an incomplete
        // assistant message; prune the incomplete trailing parts so resume
        // starts from a clean state while keeping every finished step.
        // Keep everything when pending interactions reference its tool calls.
        const resumableMessages =
          restoredPrompts.length === 0
            ? pruneIncompleteTrailingAssistantParts(validatedMessages)
            : validatedMessages;

        setMessagesRef.current(resumableMessages);
        setPendingUserPrompts(restoredPrompts);
      } catch (historyLoadError) {
        if (cancelled) {
          return;
        }

        setMessagesRef.current([]);
        setPendingApprovals([]);
        setPendingUserPrompts([]);
        setHistoryError(
          getErrorMessage(historyLoadError, "Unable to load persisted chat history."),
        );
      } finally {
        if (!cancelled) {
          setIsHistoryLoading(false);
        }
      }
    }

    void loadMessages();

    return () => {
      cancelled = true;
    };
  }, [
    isSessionIdValid,
    sessionId,
    skipHistoryLoad,
  ]);

  // Discover and attach to a server-owned run only after canonical history is
  // installed. This GET cannot repeat tool/provider side effects.
  useEffect(() => {
    if (isHistoryLoading) {
      return;
    }
    if (!isSessionIdValid || historyError) {
      setIsHistoryResumePending(false);
      return;
    }
    if (resumedSessionRef.current === sessionId) {
      return;
    }

    resumedSessionRef.current = sessionId;
    let cancelled = false;
    setIsHistoryResumePending(true);
    void resumeStream().finally(() => {
      if (!cancelled) {
        setIsHistoryResumePending(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [historyError, isHistoryLoading, isSessionIdValid, resumeStream, sessionId]);

  useEffect(() => {
    if (mode === "plan" || pendingUserPrompts.length === 0) {
      return;
    }

    for (const pendingPrompt of pendingUserPrompts) {
      queueToolOutput(
        (async () => {
          const output = {
            answer: buildModeAutoPromptResponse,
            source: "custom" as const,
          };
          await addToolOutput({
            tool: "request_user_input",
            toolCallId: pendingPrompt.toolCallId,
            output,
          });
          await markInteractionResolved(pendingPrompt.toolCallId, {
            status: "answered",
            response: output,
          });
        })(),
      );
    }

    setPendingUserPrompts([]);
    setToolExecutionError(null);
  }, [
    addToolOutput,
    markInteractionResolved,
    mode,
    pendingUserPrompts,
    queueToolOutput,
  ]);

  useEffect(() => {
    let active = true;

    async function refreshTodos() {
      if (!loadTodos) {
        if (active) {
          setTodos([]);
        }
        return;
      }

      try {
        const loadedTodos = await loadTodos({
          sessionId,
          cwd,
        });

        if (active) {
          setTodos([...loadedTodos]);
        }
      } catch {
        if (active) {
          setTodos([]);
        }
      }
    }

    void refreshTodos();

    return () => {
      active = false;
    };
  }, [cwd, loadTodos, sessionId]);

  useEffect(() => {
    if (!isSessionIdValid) {
      return;
    }

    if (isHistoryLoading || isHistoryResumePending || isCanonicalSyncing) {
      return;
    }

    if (
      !initialPrompt ||
      submittedInitialPromptRef.current === initialPrompt.trim()
    ) {
      return;
    }

    if (messages.length > 0) {
      return;
    }

    submittedInitialPromptRef.current = initialPrompt.trim();
    void sendMessage({ text: initialPrompt.trim() });
  }, [
    initialPrompt,
    isCanonicalSyncing,
    isHistoryLoading,
    isHistoryResumePending,
    isSessionIdValid,
    messages.length,
    sendMessage,
  ]);

  const hasActiveToolWork = hasActiveClientToolWork({
    messages,
    pendingApprovals,
    pendingUserPrompts,
  });
  const isStreaming =
    status === "submitted" || status === "streaming" || hasActiveToolWork;
  const isLoading =
    isHistoryLoading ||
    isHistoryResumePending ||
    isCanonicalSyncing ||
    isStreaming;
  // Recoverable errors stay invisible while automatic retries remain; the
  // status line is the only signal. Hard failures (or exhausted retries)
  // surface normally.
  const recoverableRetryPending = Boolean(
    error?.message &&
      isRecoverableChatErrorMessage(error.message) &&
      errorRetriesRef.current < maxErrorRetriesRef.current,
  );
  const providerWebSearchApprovalPending = pendingApprovals.some(
    (approval) => approval.approvalId === providerWebSearchApprovalId,
  );
  const errorMessage =
    historyError ??
    toolExecutionError ??
    (error?.message &&
    !recoverableRetryPending &&
    !providerWebSearchApprovalPending
      ? normalizeChatErrorMessage(error.message)
      : null);

  const abortActiveRun = useCallback(async () => {
    if (errorRetryTimerRef.current) {
      clearTimeout(errorRetryTimerRef.current);
      errorRetryTimerRef.current = null;
    }
    const runId = activeRunIdRef.current;
    if (runId) {
      const abortUrl = chatApi.replace(
        /\/turns(?:\?.*)?$/,
        `/runs/${encodeURIComponent(runId)}/abort`,
      );
      try {
        const headers = await resolveCodingSessionRequestOption(
          requestHeadersRef.current,
        );
        await (requestFetchRef.current ?? globalThis.fetch)(abortUrl, {
          method: "POST",
          ...(headers ? { headers } : {}),
        });
      } catch {
        // Detach locally below; the error remains visible because only the
        // companion server can authoritatively stop its provider/tool work.
      }
    }
    await stop();
    try {
      if (runId) {
        // Follow the aborted run until its run_finished event is drained. This
        // is a GET replay and cannot restart provider or tool side effects.
        await resumeStream();
      }
      await syncCanonicalHistory();
    } catch {
      // Stopping the local stream remains useful when the companion server is
      // unavailable; the normal history error path will surface on reconnect.
    }
  }, [chatApi, resumeStream, stop, syncCanonicalHistory]);

  return {
    abortActiveRun,
    autoContinueState,
    errorMessage,
    isHistoryLoading,
    isLoading,
    isStreaming,
    messages,
    pendingApprovals,
    pendingUserPrompts,
    canRetryRecoverableResponse,
    refreshPersistedMessages,
    todos,
    retryRecoverableResponse,
    resolveAllToolApprovals,
    resolveToolApproval,
    sessionId,
    status,
    respondToUserPrompt,
    sendDirectMessage,
    submitInput,
    isSessionIdValid,
  };
}
