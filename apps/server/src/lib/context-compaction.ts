import {
  buildContextSummary,
  collectMessageText,
  compressSummary,
  contextSummaryTitle,
  extractLatestProposedPlan,
  getToolNameFromPart,
  isRecord,
  safeStringify,
  type ContextStateTier,
  type ResolvedContextOptimizerConfig,
  type SessionContextState,
} from "@lightcode/ai";
import { createWorkspaceContext, loadSessionTodos } from "@lightcode/ai/runtime";
import { createLogger, getErrorMessage } from "@lightcode/shared";
import { generateText, type LanguageModel, type UIMessage } from "ai";
import { upsertSessionContextState } from "./context-state-store";

const logger = createLogger("context-compaction");

const COMPACTION_TIMEOUT_MS = 30_000;
const COMPACTION_MAX_OUTPUT_TOKENS = 1_500;
const MAX_TRANSCRIPT_CHARS = 120_000;
const MAX_MESSAGE_PREVIEW_CHARS = 2_000;
const MAX_TOOL_INPUT_PREVIEW_CHARS = 200;
const MAX_PINNED_PLAN_CHARS = 1_500;
const MIN_SUMMARY_BODY_CHARS = 400;

const COMPACTION_SYSTEM_PROMPT = `You are compacting the history of an AI coding-agent session so the session can continue seamlessly with a smaller context. Write a dense, factual summary of the conversation transcript you receive. Preserve everything a coding agent needs to keep working without re-reading the original messages.

Structure the summary with exactly these markdown sections:
## User intent and decisions
The user's goals, explicit requirements, and decisions made along the way.
## Current state
What has been built, changed, or verified so far; the state the work is in right now.
## Key files
Files that were read or modified, with one line each on why they matter.
## Pending work and next steps
Unfinished work, known follow-ups, and the immediate next step.
## Tools and commands that mattered
Important commands run and their relevant outcomes (test results, errors, etc.).

Rules: be specific (real file paths, function names, error messages); never invent details; omit pleasantries; if a "Previously compacted context" section is provided, fold its still-relevant facts into your summary instead of referencing it.`;

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function describeMessageForTranscript(message: UIMessage): string {
  const segments: string[] = [];
  const text = collectMessageText(message);
  if (text) {
    segments.push(truncateText(text, MAX_MESSAGE_PREVIEW_CHARS));
  }

  const toolSegments = message.parts
    .map((part) => {
      const toolName = getToolNameFromPart(part);
      if (!toolName) {
        return null;
      }

      const input = isRecord(part) ? Reflect.get(part, "input") : undefined;
      const inputPreview = truncateText(
        safeStringify(input ?? {}),
        MAX_TOOL_INPUT_PREVIEW_CHARS,
      );
      return `[tool ${toolName} ${inputPreview}]`;
    })
    .filter((segment): segment is string => segment !== null);

  segments.push(...toolSegments);

  return segments.join("\n") || "[no content]";
}

export function buildCompactionTranscript(
  messages: readonly UIMessage[],
): string {
  const entries = messages.map(
    (message) => `${message.role}:\n${describeMessageForTranscript(message)}`,
  );

  let transcript = entries.join("\n\n");
  while (entries.length > 1 && transcript.length > MAX_TRANSCRIPT_CHARS) {
    entries.shift();
    transcript = `[earlier messages omitted for length]\n\n${entries.join("\n\n")}`;
  }

  return transcript;
}

async function generateLlmSummary({
  coveredMessages,
  previousSummary,
  model,
}: {
  coveredMessages: readonly UIMessage[];
  previousSummary: string | null;
  model: LanguageModel;
}): Promise<string> {
  const transcript = buildCompactionTranscript(coveredMessages);
  const prompt = [
    previousSummary
      ? `Previously compacted context (already summarized):\n${previousSummary}`
      : null,
    `Conversation to compact:\n${transcript}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await generateText({
    model,
    system: COMPACTION_SYSTEM_PROMPT,
    prompt,
    maxOutputTokens: COMPACTION_MAX_OUTPUT_TOKENS,
    abortSignal: AbortSignal.timeout(COMPACTION_TIMEOUT_MS),
  });

  const text = result.text.trim();
  if (!text) {
    throw new Error("Model returned an empty compaction summary.");
  }

  return text;
}

async function buildPinnedSections({
  sessionId,
  cwd,
  coveredMessages,
}: {
  sessionId: string;
  cwd: string | undefined;
  coveredMessages: readonly UIMessage[];
}): Promise<string[]> {
  const sections: string[] = [];

  try {
    const todos = await loadSessionTodos({
      sessionId,
      workspaceContext: createWorkspaceContext(cwd),
    });
    const openTodos = todos.filter(
      (todo) => todo.status === "pending" || todo.status === "in_progress",
    );
    if (openTodos.length > 0) {
      sections.push(
        `## Active todos\n${openTodos
          .map((todo) => `- [${todo.status}] ${todo.content}`)
          .join("\n")}`,
      );
    }
  } catch (error) {
    logger.warn("context_compaction_todos_unavailable", {
      sessionId,
      error: getErrorMessage(error),
    });
  }

  const plan = extractLatestProposedPlan(coveredMessages);
  if (plan) {
    sections.push(`## Approved plan\n${truncateText(plan, MAX_PINNED_PLAN_CHARS)}`);
  }

  return sections;
}

function composeSummary({
  body,
  pinnedSections,
  summaryMaxChars,
}: {
  body: string;
  pinnedSections: readonly string[];
  summaryMaxChars: number;
}): string {
  const pinnedText = pinnedSections.join("\n\n").trim();
  const bodyBudget = Math.max(
    MIN_SUMMARY_BODY_CHARS,
    summaryMaxChars - (pinnedText ? pinnedText.length + 2 : 0),
  );
  const compressedBody = compressSummary(body, bodyBudget);

  return [compressedBody, pinnedText].filter(Boolean).join("\n\n");
}

export interface CompactSessionContextResult {
  state: SessionContextState;
  usedFallback: boolean;
}

/**
 * Tier-2 compaction: folds `coveredMessages` (full-history messages after the
 * previous anchor) into a stored summary. Tries an LLM-written summary first
 * and falls back to the extractive heuristic when the model call fails.
 */
export async function compactSessionContext({
  sessionId,
  coveredMessages,
  previousState,
  model,
  modelId,
  cwd,
  config,
  estimatedTokens,
}: {
  sessionId: string;
  coveredMessages: readonly UIMessage[];
  previousState: SessionContextState | null;
  model: LanguageModel;
  modelId: string;
  cwd: string | undefined;
  config: ResolvedContextOptimizerConfig;
  estimatedTokens: number;
}): Promise<CompactSessionContextResult> {
  if (coveredMessages.length === 0) {
    throw new Error("Context compaction requires at least one covered message.");
  }

  const anchorMessageId = coveredMessages[coveredMessages.length - 1].id;
  const coveredMessageCount =
    (previousState?.coveredMessageCount ?? 0) + coveredMessages.length;
  const pinnedSections = await buildPinnedSections({
    sessionId,
    cwd,
    coveredMessages,
  });

  let body: string;
  let tier: ContextStateTier;
  try {
    const llmSummary = await generateLlmSummary({
      coveredMessages,
      previousSummary: previousState?.summary ?? null,
      model,
    });
    body = `${contextSummaryTitle}\n\n${llmSummary}`;
    tier = "llm";
  } catch (error) {
    logger.warn("context_llm_summary_failed", {
      sessionId,
      error: getErrorMessage(error),
    });
    body = buildContextSummary({
      existingSummary: previousState?.summary ?? null,
      removedMessages: coveredMessages,
      summaryMaxChars: config.summaryMaxChars,
    });
    tier = "heuristic";
  }

  const summary = composeSummary({
    body,
    pinnedSections,
    summaryMaxChars: config.summaryMaxChars,
  });

  const state = await upsertSessionContextState({
    sessionId,
    summary,
    anchorMessageId,
    coveredMessageCount,
    estimatedTokens,
    tier,
    model: modelId,
  });

  return { state, usedFallback: tier === "heuristic" };
}
