import {
  type ChatErrorKind,
  type ChatStreamErrorInfo,
} from "@lightcode/ai";
import { createLogger, getErrorMessage } from "@lightcode/shared";
import { APICallError, RetryError } from "ai";

export type ChatFailureClass =
  | "provider_schema_rejection"
  | "provider_billing_quota"
  | "provider_auth"
  | "provider_rate_limit"
  | "provider_invalid_request"
  | "provider_unavailable"
  | "context_overflow"
  | "provider_unknown"
  | "timeout_disconnect"
  | "stale_finish_skip"
  | "db_unique_conflict";

const chatFailureCounters: Record<ChatFailureClass, number> = {
  provider_schema_rejection: 0,
  provider_billing_quota: 0,
  provider_auth: 0,
  provider_rate_limit: 0,
  provider_invalid_request: 0,
  provider_unavailable: 0,
  context_overflow: 0,
  provider_unknown: 0,
  timeout_disconnect: 0,
  stale_finish_skip: 0,
  db_unique_conflict: 0,
};

export function chatFailureClassForErrorKind(
  kind: ChatErrorKind,
): ChatFailureClass {
  switch (kind) {
    case "auth":
      return "provider_auth";
    case "billing":
      return "provider_billing_quota";
    case "rate_limit":
      return "provider_rate_limit";
    case "invalid_request":
      return "provider_invalid_request";
    case "context_overflow":
      return "context_overflow";
    case "provider_unavailable":
      return "provider_unavailable";
    case "network":
    case "aborted":
      return "timeout_disconnect";
    default:
      return "provider_unknown";
  }
}

export type ChatWriteLogPhase = "pre-stream" | "finish";

const logger = createLogger("chat");

export { getErrorMessage };

function normalizeErrorMessage(message: string) {
  return message.toLowerCase();
}

export function isProviderSchemaRejectionError(error: unknown) {
  const message = normalizeErrorMessage(getErrorMessage(error));

  return (
    (message.includes("invalid_request_error") || message.includes("invalid request")) &&
    (message.includes("input_schema") || message.includes("schema") || message.includes("tool"))
  );
}

export function isProviderBillingOrQuotaError(error: unknown) {
  const message = normalizeErrorMessage(getErrorMessage(error));

  return (
    message.includes("credit balance") ||
    message.includes("insufficient credit") ||
    message.includes("insufficient funds") ||
    message.includes("out of credits") ||
    message.includes("quota") ||
    message.includes("billing") ||
    message.includes("payment required")
  );
}

// Same whitelist claw-code uses: statuses where resending the identical
// request can plausibly succeed. Everything else fails fast and surfaces.
const retryableStatusCodes = new Set([408, 409, 429, 500, 502, 503, 504]);

const contextOverflowPattern =
  /(context window|context length|context_length|maximum context|prompt is too long|input is too long|too many tokens|exceeds? the (?:maximum|model'?s) (?:context|token)|max(?:imum)? input tokens)/i;

function isContextOverflowMessage(message: string) {
  return contextOverflowPattern.test(message);
}

// Providers report the real ceiling in the overflow body, e.g. "This endpoint's
// maximum context length is 1048576 tokens." Capturing it lets the server size
// the next request against the true serving limit instead of an optimistic
// catalog window, so recovery succeeds on the first retry.
const contextLimitPattern =
  /(?:maximum context (?:length|window)|max(?:imum)? input (?:length|tokens)|context (?:length|window) of)\D{0,40}?(\d{4,})/i;

export function extractContextLimitTokens(message: string): number | undefined {
  const match = contextLimitPattern.exec(message);
  if (!match) {
    return undefined;
  }

  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function isAbortError(error: unknown) {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    normalizeErrorMessage(getErrorMessage(error)).includes("aborted")
  );
}

function classifyByStatusCode(
  statusCode: number,
  message: string,
): { kind: ChatErrorKind; retryable: boolean } {
  if (statusCode === 401 || statusCode === 403) {
    return { kind: "auth", retryable: false };
  }

  if (statusCode === 402) {
    return { kind: "billing", retryable: false };
  }

  if (statusCode === 429) {
    return { kind: "rate_limit", retryable: true };
  }

  if (statusCode === 400 || statusCode === 422 || statusCode === 413) {
    if (isContextOverflowMessage(message)) {
      // Retryable because the server compacts the provider view harder on
      // every overflow round (claw-code's progressive schedule) — the resend
      // is against a smaller request, not a blind repeat.
      return { kind: "context_overflow", retryable: true };
    }

    if (isProviderBillingOrQuotaError(message)) {
      return { kind: "billing", retryable: false };
    }

    return { kind: "invalid_request", retryable: false };
  }

  if (retryableStatusCodes.has(statusCode) || statusCode >= 500) {
    return { kind: "provider_unavailable", retryable: true };
  }

  return { kind: "unknown", retryable: false };
}

/**
 * Structured error classification. Prefers AI SDK `APICallError` metadata
 * (status code + response body) over string matching; the string heuristics
 * above remain as fallback for transport-level errors.
 */
export function classifyChatError(error: unknown): ChatStreamErrorInfo {
  // RetryError wraps the per-attempt errors after the SDK's own retries.
  if (RetryError.isInstance(error) && error.lastError) {
    return classifyChatError(error.lastError);
  }

  if (APICallError.isInstance(error)) {
    const responseBody = error.responseBody ?? "";
    const message = responseBody.length > 0 ? responseBody : error.message;

    if (typeof error.statusCode === "number") {
      const { kind, retryable } = classifyByStatusCode(
        error.statusCode,
        message,
      );

      return {
        kind,
        statusCode: error.statusCode,
        retryable,
        message,
        contextLimitTokens:
          kind === "context_overflow"
            ? extractContextLimitTokens(message)
            : undefined,
      };
    }

    return {
      kind: error.isRetryable ? "network" : "unknown",
      retryable: error.isRetryable,
      message,
    };
  }

  const message = getErrorMessage(error);

  if (isAbortError(error)) {
    return { kind: "aborted", retryable: false, message };
  }

  if (isContextOverflowMessage(message)) {
    return {
      kind: "context_overflow",
      retryable: true,
      message,
      contextLimitTokens: extractContextLimitTokens(message),
    };
  }

  if (isProviderBillingOrQuotaError(error)) {
    return { kind: "billing", retryable: false, message };
  }

  if (isProviderSchemaRejectionError(error)) {
    return { kind: "invalid_request", retryable: false, message };
  }

  if (isDisconnectOrTimeoutError(error)) {
    return { kind: "network", retryable: true, message };
  }

  return { kind: "unknown", retryable: false, message };
}

export function isDisconnectOrTimeoutError(error: unknown) {
  const message = normalizeErrorMessage(getErrorMessage(error));

  return (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("socket") ||
    message.includes("connection") ||
    message.includes("aborted") ||
    message.includes("broken pipe") ||
    message.includes("econnreset")
  );
}

export function logChatWriteEvent({
  sessionId,
  revision,
  phase,
  staleSkip,
}: {
  sessionId: string;
  revision: number;
  phase: ChatWriteLogPhase;
  staleSkip: boolean;
}) {
  logger.info("chat_write", {
    sessionId,
    revision,
    phase,
    staleSkip,
  });
}

export function incrementChatFailureCounter(
  failureClass: ChatFailureClass,
  context: Record<string, unknown> = {}
) {
  chatFailureCounters[failureClass] += 1;

  logger.warn("chat_failure", {
    failureClass,
    count: chatFailureCounters[failureClass],
    ...context,
  });
}

/**
 * Logs a classified provider/stream error with the FULL provider message —
 * the client only receives a truncated envelope, so this log line is the
 * source of truth when debugging failures.
 */
export function logChatStreamErrorEvent({
  sessionId,
  phase,
  classified,
  error,
}: {
  sessionId: string;
  phase: ChatWriteLogPhase | "stream";
  classified: ChatStreamErrorInfo;
  error: unknown;
}) {
  logger.error("chat_stream_error", {
    sessionId,
    phase,
    kind: classified.kind,
    statusCode: classified.statusCode,
    retryable: classified.retryable,
    message: classified.message,
    rawMessage: getErrorMessage(error),
  });
}

export function logChatDisconnectEvent({
  sessionId,
  phase,
  error,
}: {
  sessionId: string;
  phase: ChatWriteLogPhase | "stream";
  error: unknown;
}) {
  logger.warn("chat_disconnect", {
    sessionId,
    phase,
    disconnect: true,
    message: getErrorMessage(error),
  });
}
