import { createLogger, getErrorMessage } from "@lightcode/shared";

export type ChatFailureClass =
  | "provider_schema_rejection"
  | "provider_billing_quota"
  | "timeout_disconnect"
  | "stale_finish_skip"
  | "db_unique_conflict";

const chatFailureCounters: Record<ChatFailureClass, number> = {
  provider_schema_rejection: 0,
  provider_billing_quota: 0,
  timeout_disconnect: 0,
  stale_finish_skip: 0,
  db_unique_conflict: 0,
};

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
