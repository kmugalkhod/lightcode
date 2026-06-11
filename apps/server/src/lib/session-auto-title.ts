import { collectMessageText } from "@lightcode/ai";
import { createLogger, getErrorMessage } from "@lightcode/shared";
import { generateText, type UIMessage } from "ai";
import { applyGeneratedSessionTitle } from "./chat-store";
import { prisma } from "./prisma-client";
import { chatModelId, resolvedProviderModel } from "./runtime-config";

const logger = createLogger("session-auto-title");

const AUTO_TITLE_TIMEOUT_MS = 15_000;
const AUTO_TITLE_MAX_OUTPUT_TOKENS = 24;
const AUTO_TITLE_INPUT_PREVIEW_CHARS = 600;

function sanitizeGeneratedTitle(raw: string): string | null {
  const title = raw
    .split(/\r?\n/)[0]
    .replace(/^["'`#\s-]+|["'`.\s]+$/g, "")
    .trim();

  return title.length >= 3 ? title : null;
}

async function generateSessionTitle({
  sessionId,
  messages,
}: {
  sessionId: string;
  messages: readonly UIMessage[];
}): Promise<void> {
  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { autoTitled: true },
  });
  if (!session || session.autoTitled) {
    return;
  }

  const firstUserText = messages
    .filter((message) => message.role === "user")
    .map(collectMessageText)
    .find((text) => text.trim());
  const firstAssistantText = messages
    .filter((message) => message.role === "assistant")
    .map(collectMessageText)
    .find((text) => text.trim());

  if (!firstUserText || !firstAssistantText) {
    return;
  }

  const result = await generateText({
    model: resolvedProviderModel.model,
    system:
      "Write a 3-6 word title for a coding session. Reply with the title only - no quotes, no punctuation at the end.",
    prompt: `Request: ${firstUserText.slice(0, AUTO_TITLE_INPUT_PREVIEW_CHARS)}\n\nResponse: ${firstAssistantText.slice(0, AUTO_TITLE_INPUT_PREVIEW_CHARS)}`,
    maxOutputTokens: AUTO_TITLE_MAX_OUTPUT_TOKENS,
    abortSignal: AbortSignal.timeout(AUTO_TITLE_TIMEOUT_MS),
  });

  const title = sanitizeGeneratedTitle(result.text);
  if (title && (await applyGeneratedSessionTitle(sessionId, title))) {
    logger.info("session_auto_titled", { sessionId, title, model: chatModelId });
  }
}

/**
 * Fire-and-forget: titles the session from its first exchange. Failures are
 * logged and never affect the chat flow.
 */
export function maybeScheduleSessionAutoTitle({
  sessionId,
  messages,
}: {
  sessionId: string;
  messages: readonly UIMessage[];
}): void {
  void generateSessionTitle({ sessionId, messages }).catch((error) => {
    logger.warn("session_auto_title_failed", {
      sessionId,
      error: getErrorMessage(error),
    });
  });
}
