/**
 * Machine-readable chat stream error envelope.
 *
 * The AI SDK UI stream only carries error *strings* from server to client, so
 * the server encodes structured classification into the string and the client
 * decodes it. Plain strings (old servers, third-party errors) parse to null
 * and fall back to heuristics.
 */

export type ChatErrorKind =
  | "auth"
  | "billing"
  | "rate_limit"
  | "invalid_request"
  | "context_overflow"
  | "provider_unavailable"
  | "network"
  | "aborted"
  | "unknown";

export interface ChatStreamErrorInfo {
  kind: ChatErrorKind;
  statusCode?: number;
  /** Whether resending the same request can plausibly succeed. */
  retryable: boolean;
  /** Provider/transport message, truncated for transport. */
  message: string;
}

const chatStreamErrorPrefix = "LIGHTCODE_ERROR:";
const maxTransportMessageLength = 500;

const chatErrorKinds: ReadonlySet<string> = new Set([
  "auth",
  "billing",
  "rate_limit",
  "invalid_request",
  "context_overflow",
  "provider_unavailable",
  "network",
  "aborted",
  "unknown",
]);

export function formatChatStreamError(info: ChatStreamErrorInfo): string {
  const payload: ChatStreamErrorInfo = {
    ...info,
    message: info.message.slice(0, maxTransportMessageLength),
  };

  return `${chatStreamErrorPrefix}${JSON.stringify(payload)}`;
}

export function parseChatStreamError(
  message: string | undefined | null,
): ChatStreamErrorInfo | null {
  if (!message || !message.startsWith(chatStreamErrorPrefix)) {
    return null;
  }

  try {
    const parsed = JSON.parse(message.slice(chatStreamErrorPrefix.length));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.message !== "string" ||
      typeof parsed.retryable !== "boolean" ||
      typeof parsed.kind !== "string" ||
      !chatErrorKinds.has(parsed.kind)
    ) {
      return null;
    }

    return {
      kind: parsed.kind as ChatErrorKind,
      statusCode:
        typeof parsed.statusCode === "number" ? parsed.statusCode : undefined,
      retryable: parsed.retryable,
      message: parsed.message,
    };
  } catch {
    return null;
  }
}

const chatErrorKindLabels: Record<ChatErrorKind, string> = {
  auth: "Authentication error",
  billing: "Billing or quota error",
  rate_limit: "Rate limited",
  invalid_request: "Provider rejected the request",
  context_overflow: "Context window exceeded",
  provider_unavailable: "Provider unavailable",
  network: "Connection error",
  aborted: "Request aborted",
  unknown: "Provider error",
};

/** Human-readable form for the TUI, keeping the real provider message. */
export function describeChatStreamError(info: ChatStreamErrorInfo): string {
  const status = info.statusCode ? ` (HTTP ${info.statusCode})` : "";
  return `${chatErrorKindLabels[info.kind]}${status}: ${info.message}`;
}
