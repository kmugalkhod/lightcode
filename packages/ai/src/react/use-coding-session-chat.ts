import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  type FileUIPart,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithToolCalls,
  safeValidateUIMessages,
  type UIMessage,
} from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  codingToolInputSchemas,
  evaluateCodingToolPermission,
  resolveCodingPermissionMode,
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
  chatInteractionToolApprovalPayloadSchema,
  chatInteractionResolveRequestSchema,
  chatInteractionUpsertRequestSchema,
  chatInteractionUserPromptPayloadSchema,
  type ChatInteraction,
  type ChatInteractionListResponse,
  type ChatInteractionResolveRequest,
  type ChatInteractionUpsertRequest,
} from "../chat-interaction-schemas";
import { toSingleLinePreview } from "../common/output-utils";
import { createWorkspaceContext } from "../common/resolve-within-workspace";
import {
  executeCodingTool as executeCodingToolRuntime,
  type CodingToolExecutionOptions,
  parseCodingToolInput,
} from "../runtime-registry";
import {
  defaultCodingAgentMode,
  type CodingAgentMode,
} from "../coding-agent-modes";
import {
  formatPermissionDecision,
  isPermissionDeniedError,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRules,
} from "../permissions";
import type { SandboxConfig } from "../sandbox/config";
import {
  requestUserInputToolOutputSchema,
  type RequestUserInputToolOutput,
} from "../request-user-input/schema";
import { loadSessionTodos } from "../todo-write/runtime";
import type { TodoItem } from "../todo-write/schema";
import {
  decideAutoContinue,
  defaultAutoContinueLimits,
  shouldTreatAsStalled,
  type AutoContinueDecision,
  type AutoContinueKind,
} from "./auto-continue";
import { resolveDanglingToolParts } from "../context/normalize-provider-messages";

export type ToolApprovalAction = "approve" | "deny";

type ApprovalCommandTarget = number | "all";

const recoverableDisconnectMessage =
  "Connection interrupted. Please retry or regenerate your last message.";
const buildModeAutoPromptResponse =
  "Proceed with implementation in Build mode. Continue without additional plan questions.";
const chatMessageUpdateThrottleMs = 50;
const retryCommandPattern = /^\/?(retry|regenerate)$/i;

const codingToolNameSet = new Set<string>(Object.keys(codingToolInputSchemas));
type CodingToolInput = CodingToolInputByName[CodingToolName];
type CodingToolOutput = CodingToolOutputByName[CodingToolName];
type RequestUserInputToolInput = CodingToolInputByName["request_user_input"];

export interface PendingToolApproval {
  toolCallId: string;
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
  cwd?: string;
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

async function executeCodingTool(
  toolName: CodingToolName,
  input: CodingToolInput,
  options: CodingToolExecutionOptions,
): Promise<CodingToolOutput> {
  return executeCodingToolRuntime(toolName, input, options);
}

function getToolErrorMessage(error: unknown, fallback: string) {
  if (isPermissionDeniedError(error)) {
    return formatPermissionDecision(error.decision);
  }

  return getErrorMessage(error, fallback);
}

function buildExecutionOptions({
  mode,
  cwd,
  sessionId,
  permissionMode,
  allowedTools,
  permissionRules,
  approved,
  sandbox,
}: {
  mode: CodingAgentMode;
  cwd: string;
  sessionId: string;
  permissionMode?: PermissionMode;
  allowedTools?: readonly CodingToolName[];
  permissionRules?: PermissionRules;
  approved?: boolean;
  sandbox?: SandboxConfig;
}): CodingToolExecutionOptions {
  return {
    mode,
    permissionMode: resolveCodingPermissionMode({ mode, permissionMode }),
    allowedTools,
    permissionRules,
    approved,
    cwd,
    sessionId,
    sandbox,
  };
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

function queueToolOutput(outputResult: void | PromiseLike<void>) {
  if (!outputResult) {
    return;
  }

  void Promise.resolve(outputResult).catch((outputError) => {
    console.warn("Failed to add tool output.", outputError);
  });
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
  // Drop only the incomplete trailing parts (preserving finished steps), then
  // resolve any remaining dangling tool call via the shared server/client
  // normalizer so retry and first-send produce identical, valid histories.
  return resolveDanglingToolParts(pruneIncompleteTrailingAssistantParts(messages));
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

function restorePendingApproval(
  interaction: ChatInteraction,
): PendingToolApproval | null {
  if (interaction.kind !== "tool_approval" || interaction.status !== "pending") {
    return null;
  }

  const payloadResult = chatInteractionToolApprovalPayloadSchema.safeParse(
    interaction.payload,
  );
  if (!payloadResult.success) {
    return null;
  }

  try {
    const input = parseCodingToolInput(
      payloadResult.data.toolName,
      payloadResult.data.input,
    );

    return {
      toolCallId: interaction.toolCallId,
      toolName: payloadResult.data.toolName,
      input,
      summary: payloadResult.data.summary,
      permissionDecision: payloadResult.data.permissionDecision,
      cwd: payloadResult.data.cwd,
    };
  } catch {
    return null;
  }
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
  cwd = process.cwd(),
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
  const loadPersistedMessagesRef = useRef(loadPersistedMessages);
  const loadPersistedInteractionsRef = useRef(loadPersistedInteractions);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [toolExecutionError, setToolExecutionError] = useState<string | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(true);
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
  loadPersistedMessagesRef.current = loadPersistedMessages;
  loadPersistedInteractionsRef.current = loadPersistedInteractions;

  const transport = useMemo(() => {
    // Stall detection must observe transport bytes, not React state updates:
    // server heartbeats and reasoning deltas prove the connection is alive
    // even when nothing user-visible renders for minutes.
    const monitoredFetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const response = await globalThis.fetch(input, init);
      lastStreamActivityRef.current = Date.now();

      if (!response.body) {
        return response;
      }

      const monitoredBody = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            lastStreamActivityRef.current = Date.now();
            controller.enqueue(chunk);
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
      body: () => ({
        cwd: cwdRef.current,
        mode: modeRef.current,
        permissionMode: permissionModeRef.current,
        allowedTools: allowedToolsRef.current,
        permissionRules: permissionRulesRef.current,
        sandbox: sandboxRef.current,
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

  const {
    messages,
    setMessages,
    sendMessage,
    addToolOutput,
    clearError,
    error,
    status,
    stop,
  } =
    useChat<UIMessage>({
      id: sessionId,
      transport,
      experimental_throttle: chatMessageUpdateThrottleMs,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
      onToolCall: async ({ toolCall }) => {
        if (toolCall.dynamic || !isCodingToolName(toolCall.toolName)) {
          return;
        }

        const toolName = toolCall.toolName;
        let parsedInput: CodingToolInput;

        try {
          parsedInput = parseCodingToolInput(toolName, toolCall.input);
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

        if (isRequestUserInputToolName(toolName)) {
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

          const promptInput = parsedInput as RequestUserInputToolInput;
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

          return;
        }

        const permissionDecision = evaluateCodingToolPermission({
          toolName,
          input: parsedInput,
          mode,
          permissionMode,
          allowedTools,
          permissionRules,
        });

        if (permissionDecision.outcome === "deny") {
          queueToolOutput(
            addToolOutput({
              tool: toolName,
              toolCallId: toolCall.toolCallId,
              state: "output-error",
              errorText: formatPermissionDecision(permissionDecision),
            }),
          );
          return;
        }

        if (permissionDecision.outcome === "ask") {
          const pendingApproval: PendingToolApproval = {
            toolCallId: toolCall.toolCallId,
            toolName,
            input: parsedInput,
            summary: summarizeToolCall(toolName, parsedInput),
            permissionDecision,
            cwd,
          };

          void checkpointInteraction(
            chatInteractionUpsertRequestSchema.parse({
              kind: "tool_approval",
              toolCallId: toolCall.toolCallId,
              payload: {
                toolName,
                input: parsedInput,
                summary: pendingApproval.summary,
                permissionDecision,
                cwd,
              },
            }),
          );

          setPendingApprovals((previousApprovals) => {
            if (
              previousApprovals.some(
                (item) => item.toolCallId === toolCall.toolCallId,
              )
            ) {
              return previousApprovals;
            }

            return [...previousApprovals, pendingApproval];
          });

          return;
        }

        try {
          const output = await executeCodingTool(
            toolName,
            parsedInput,
            {
              ...buildExecutionOptions({
                mode,
                cwd,
                sessionId,
                permissionMode,
                allowedTools,
                permissionRules,
                sandbox,
              }),
              turnKey: turnKeyRef.current,
            },
          );
          if (isTodoWriteOutput(toolName, output)) {
            setTodos(output.todos);
          }
          queueToolOutput(
            addToolOutput({
              tool: toolName,
              toolCallId: toolCall.toolCallId,
              output,
            }),
          );
        } catch (toolError) {
          queueToolOutput(
            addToolOutput({
              tool: toolName,
              toolCallId: toolCall.toolCallId,
              state: "output-error",
              errorText: getToolErrorMessage(toolError, "Tool execution failed."),
            }),
          );
        }
      },
    });

  const setMessagesRef = useRef(setMessages);
  setMessagesRef.current = setMessages;

  const runApprovedTool = useCallback(
    async (approval: PendingToolApproval) => {
      try {
        const output = await executeCodingTool(
          approval.toolName,
          approval.input,
          {
            ...buildExecutionOptions({
              mode,
              cwd,
              sessionId,
              permissionMode,
              allowedTools,
              permissionRules,
              approved: true,
              sandbox,
            }),
            turnKey: turnKeyRef.current,
          },
        );
        if (isTodoWriteOutput(approval.toolName, output)) {
          setTodos(output.todos);
        }
        await addToolOutput({
          tool: approval.toolName,
          toolCallId: approval.toolCallId,
          output,
        });
        await markInteractionResolved(
          approval.toolCallId,
          chatInteractionResolveRequestSchema.parse({
            status: "approved",
            response: output,
          }),
        );
      } catch (toolError) {
        const errorText = getToolErrorMessage(toolError, "Tool execution failed.");
        await addToolOutput({
          tool: approval.toolName,
          toolCallId: approval.toolCallId,
          state: "output-error",
          errorText,
        });
        await markInteractionResolved(approval.toolCallId, {
          status: "approved",
          response: {
            errorText,
          },
        });
      }
    },
    [
      addToolOutput,
      allowedTools,
      cwd,
      markInteractionResolved,
      mode,
      permissionMode,
      permissionRules,
      sandbox,
      sessionId,
    ],
  );

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
      setPendingApprovals((current) =>
        current.filter((item) => item.toolCallId !== selectedApproval.toolCallId),
      );
      setToolExecutionError(null);

      if (action === "deny") {
        void (async () => {
          await addToolOutput({
            tool: selectedApproval.toolName,
            toolCallId: selectedApproval.toolCallId,
            state: "output-error",
            errorText: "Tool execution denied by user.",
          });
          await markInteractionResolved(selectedApproval.toolCallId, {
            status: "denied",
            response: {
              errorText: "Tool execution denied by user.",
            },
          });
        })();
        return;
      }

      void runApprovedTool(selectedApproval);
    },
    [addToolOutput, markInteractionResolved, pendingApprovals, runApprovedTool],
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

      if (action === "deny") {
        void (async () => {
          for (const approval of selectedApprovals) {
            await addToolOutput({
              tool: approval.toolName,
              toolCallId: approval.toolCallId,
              state: "output-error",
              errorText: "Tool execution denied by user.",
            });
            await markInteractionResolved(approval.toolCallId, {
              status: "denied",
              response: {
                errorText: "Tool execution denied by user.",
              },
            });
          }
        })();
        return;
      }

      void (async () => {
        for (const approval of selectedApprovals) {
          await runApprovedTool(approval);
        }
      })();
    },
    [addToolOutput, markInteractionResolved, pendingApprovals, runApprovedTool],
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
      void (async () => {
        await addToolOutput({
          tool: "request_user_input",
          toolCallId,
          output: parsedResponse.data,
        });
        await markInteractionResolved(toolCallId, {
          status: "answered",
          response: parsedResponse.data,
        });
      })();
    },
    [addToolOutput, markInteractionResolved, pendingUserPrompts],
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

    const retryMessages = sanitizeMessagesForRetry(messages);
    setMessages(retryMessages);
    clearError();
    setToolExecutionError(null);
    await sendMessage();
  }, [
    clearError,
    error?.message,
    messages,
    pendingApprovals.length,
    pendingUserPrompts.length,
    sendMessage,
    setMessages,
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
          // Sanitize, don't just trim: an aborted stream can leave a complete
          // tool call without a result, and resending that history makes the
          // provider reject every retry with HTTP 400.
          setMessages((current) => sanitizeMessagesForRetry(current));
          clearError();
          setToolExecutionError(null);
          await sendMessage();
        } finally {
          stallRecoveryInFlightRef.current = false;
        }
      })();
    }, 15_000);

    return () => clearInterval(intervalId);
  }, [clearError, registerRetryProgress, sendMessage, setMessages, status, stop]);

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
    isHistoryLoading,
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

    const retryMessages = sanitizeMessagesForRetry(messages);
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
      setMessages(retryMessages);
      clearError();
      setToolExecutionError(null);
      void sendMessage();
    }, delay);

    return () => {
      if (errorRetryTimerRef.current) {
        clearTimeout(errorRetryTimerRef.current);
        errorRetryTimerRef.current = null;
      }
    };
  }, [
    clearError,
    error?.message,
    messages,
    pendingApprovals.length,
    pendingUserPrompts.length,
    registerRetryProgress,
    sendMessage,
    setMessages,
  ]);

  const submitInput = useCallback(
    (text: string, files?: FileUIPart[]) => {
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
      void sendMessage({ text, files });
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

  useEffect(() => {
    let cancelled = false;
    submittedInitialPromptRef.current = null;
    setHistoryError(null);
    setToolExecutionError(null);
    setPendingApprovals([]);
    setPendingUserPrompts([]);
    setIsHistoryLoading(true);

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
        const validatedMessages = await validatePersistedMessages(
          messagePayload.messages,
        );
        const restoredApprovals = interactionPayload.interactions
          .map(restorePendingApproval)
          .filter((approval): approval is PendingToolApproval => approval !== null);
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
          restoredApprovals.length === 0 && restoredPrompts.length === 0
            ? pruneIncompleteTrailingAssistantParts(validatedMessages)
            : validatedMessages;

        setMessagesRef.current(resumableMessages);
        setPendingApprovals(restoredApprovals);
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

  useEffect(() => {
    if (mode === "plan" || pendingUserPrompts.length === 0) {
      return;
    }

    for (const pendingPrompt of pendingUserPrompts) {
      void (async () => {
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
      })();
    }

    setPendingUserPrompts([]);
    setToolExecutionError(null);
  }, [addToolOutput, markInteractionResolved, mode, pendingUserPrompts]);

  useEffect(() => {
    let active = true;

    async function refreshTodos() {
      try {
        const workspaceContext = createWorkspaceContext(cwd);
        const loadedTodos = await loadSessionTodos({
          sessionId,
          workspaceContext,
        });

        if (active) {
          setTodos(loadedTodos);
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
  }, [cwd, sessionId]);

  useEffect(() => {
    if (!isSessionIdValid) {
      return;
    }

    if (isHistoryLoading) {
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
  }, [initialPrompt, isHistoryLoading, isSessionIdValid, messages.length, sendMessage]);

  const hasActiveToolWork = hasActiveClientToolWork({
    messages,
    pendingApprovals,
    pendingUserPrompts,
  });
  const isStreaming =
    status === "submitted" || status === "streaming" || hasActiveToolWork;
  const isLoading = isHistoryLoading || isStreaming;
  // Recoverable errors stay invisible while automatic retries remain; the
  // status line is the only signal. Hard failures (or exhausted retries)
  // surface normally.
  const recoverableRetryPending = Boolean(
    error?.message &&
      isRecoverableChatErrorMessage(error.message) &&
      errorRetriesRef.current < maxErrorRetriesRef.current,
  );
  const errorMessage =
    historyError ??
    toolExecutionError ??
    (error?.message && !recoverableRetryPending
      ? normalizeChatErrorMessage(error.message)
      : null);

  return {
    autoContinueState,
    errorMessage,
    isHistoryLoading,
    isLoading,
    isStreaming,
    messages,
    pendingApprovals,
    pendingUserPrompts,
    canRetryRecoverableResponse,
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
