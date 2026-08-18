import {
  artifactizeLargeToolOutputs,
  buildContextSummary,
  collectConversationTurnRanges,
  collectMessageText,
  compressSummary,
  contextSummaryTitle,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  extractLatestProposedPlan,
  getToolNameFromPart,
  isRecord,
  ProviderTurnAssembler,
  safeStringify,
  type ContextStateTier,
  type ResolvedContextOptimizerConfig,
  type SessionContextState,
} from "@lightcode/ai";
import { createWorkspaceContext, loadSessionTodos } from "@lightcode/ai/runtime";
import { createLogger, getErrorMessage } from "@lightcode/shared";
import {
  generateText,
  type LanguageModel,
  type ModelMessage,
  type UIMessage,
} from "ai";
import { upsertSessionContextState } from "./context-state-store";

const logger = createLogger("context-compaction");

const COMPACTION_TIMEOUT_MS = 30_000;
const COMPACTION_MAX_OUTPUT_TOKENS = 1_500;
const MAX_TRANSCRIPT_CHARS = 120_000;
const MAX_MESSAGE_PREVIEW_CHARS = 2_000;
const MAX_TOOL_INPUT_PREVIEW_CHARS = 200;
const MAX_TOOL_OUTPUT_PREVIEW_CHARS = 800;
const MAX_PINNED_PLAN_CHARS = 1_500;
const MIN_SUMMARY_BODY_CHARS = 400;

const COMPACTION_SYSTEM_PROMPT = `You are compacting the history of an AI coding-agent session so the session can continue seamlessly with a smaller context. Write a dense, factual summary of the conversation transcript you receive. Preserve everything a coding agent needs to keep working without re-reading the original messages.

Structure the summary with exactly these markdown sections:
## Goal, constraints, and decisions
The user's objective, explicit requirements, approvals, rejected approaches, and decisions.
## Current implementation and changed files
What was read or changed, with exact paths/symbols and the current state.
## Tests, commands, and outcomes
Commands run, pass/fail counts, relevant output, and verification still required.
## Tool errors, blockers, and approvals
Important tool failures, permission decisions, unresolved risks, and blockers.
## Pending todos and next action
Unfinished work followed by one concrete immediate next action.

Rules: be specific (real file paths, function names, error messages); never invent details; omit pleasantries; if a "Previously compacted context" section is provided, fold its still-relevant facts into your summary instead of referencing it.`;

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

/** Retains both the cause and outcome of long tool output. */
function boundedHeadTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const marker = "\n… [middle omitted] …\n";
  const available = Math.max(0, maxChars - marker.length);
  const headChars = Math.ceil(available * 0.6);
  const tailChars = available - headChars;
  return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`;
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
      const state = isRecord(part) ? Reflect.get(part, "state") : undefined;
      const output = isRecord(part) ? Reflect.get(part, "output") : undefined;
      const error = isRecord(part)
        ? (Reflect.get(part, "errorText") ?? Reflect.get(part, "error"))
        : undefined;
      const evidence = error ?? output;
      const evidencePreview =
        evidence === undefined
          ? ""
          : `\n${error === undefined ? "output" : "error"}: ${boundedHeadTail(
              safeStringify(evidence),
              MAX_TOOL_OUTPUT_PREVIEW_CHARS,
            )}`;
      return `[tool ${toolName}${typeof state === "string" ? ` state=${state}` : ""} input=${inputPreview}]${evidencePreview}`;
    })
    .filter((segment): segment is string => segment !== null);

  segments.push(...toolSegments);

  return segments.join("\n") || "[no content]";
}

export function buildCompactionTranscript(
  messages: readonly UIMessage[],
): string {
  const ranges = collectConversationTurnRanges(messages, () => 0);
  const groups = ranges.map((range) =>
    messages
      .slice(range.startIndex, range.endIndex)
      .map(
        (message) =>
          `${message.role}:\n${describeMessageForTranscript(message)}`,
      )
      .join("\n\n"),
  );

  // Histories should start at a user boundary. Preserve any legacy preamble
  // as one indivisible group so length fitting still never strands an
  // assistant message apart from its surrounding context.
  if (ranges[0]?.startIndex && ranges[0].startIndex > 0) {
    groups.unshift(
      messages
        .slice(0, ranges[0].startIndex)
        .map(
          (message) =>
            `${message.role}:\n${describeMessageForTranscript(message)}`,
        )
        .join("\n\n"),
    );
  }
  if (groups.length === 0) {
    groups.push(
      messages
        .map(
          (message) =>
            `${message.role}:\n${describeMessageForTranscript(message)}`,
        )
        .join("\n\n"),
    );
  }

  let omitted = false;
  const render = () =>
    `${omitted ? "[earlier complete turns omitted for length]\n\n" : ""}${groups.join("\n\n")}`;
  let transcript = render();
  while (groups.length > 1 && transcript.length > MAX_TRANSCRIPT_CHARS) {
    groups.shift();
    omitted = true;
    transcript = render();
  }

  // A single pathological turn remains one turn; bound its internal evidence
  // head/tail rather than dropping only its user or assistant half.
  return transcript.length > MAX_TRANSCRIPT_CHARS
    ? boundedHeadTail(transcript, MAX_TRANSCRIPT_CHARS)
    : transcript;
}

async function generateLlmSummary({
  coveredMessages,
  previousSummary,
  model,
  abortSignal,
  contextWindow,
}: {
  coveredMessages: readonly UIMessage[];
  previousSummary: string | null;
  model: LanguageModel;
  abortSignal?: AbortSignal;
  contextWindow: number;
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
  const assembler = new ProviderTurnAssembler({
    system: COMPACTION_SYSTEM_PROMPT,
    contextWindow,
    reservedOutputTokens: COMPACTION_MAX_OUTPUT_TOKENS,
  });
  const artifactized = await artifactizeLargeToolOutputs(
    [{ role: "user", content: prompt } satisfies ModelMessage],
    { signal: abortSignal },
  );
  const assembled = assembler.assembleModelMessages(
    artifactized.messages,
    { preserveRecentTokens: 0 },
  );
  if (!assembled.withinBudget) {
    throw new Error(
      "context_input_too_large: the compaction transcript cannot fit the model context window.",
    );
  }

  const result = await generateText({
    model,
    system: COMPACTION_SYSTEM_PROMPT,
    messages: assembled.messages,
    maxOutputTokens: COMPACTION_MAX_OUTPUT_TOKENS,
    maxRetries: 2,
    abortSignal: abortSignal
      ? AbortSignal.any([
          abortSignal,
          AbortSignal.timeout(COMPACTION_TIMEOUT_MS),
        ])
      : AbortSignal.timeout(COMPACTION_TIMEOUT_MS),
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

// Appended after every compaction so the model resumes the task directly
// instead of stalling on "shall I continue?" — the difference between a long
// task surviving compaction and dying at it.
export const compactionDirectResumeInstruction =
  "Continue the task from where it left off using the summary above. " +
  "Do not ask for confirmation, do not re-state the plan, and do not repeat completed work.";

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

  return [compressedBody, pinnedText, compactionDirectResumeInstruction]
    .filter(Boolean)
    .join("\n\n");
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
  abortSignal,
  contextWindow = DEFAULT_CONTEXT_WINDOW_TOKENS,
}: {
  sessionId: string;
  coveredMessages: readonly UIMessage[];
  previousState: SessionContextState | null;
  model: LanguageModel;
  modelId: string;
  cwd: string | undefined;
  config: ResolvedContextOptimizerConfig;
  estimatedTokens: number;
  abortSignal?: AbortSignal;
  contextWindow?: number;
}): Promise<CompactSessionContextResult> {
  if (coveredMessages.length === 0) {
    throw new Error("Context compaction requires at least one covered message.");
  }
  abortSignal?.throwIfAborted();

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
      abortSignal,
      contextWindow,
    });
    body = `${contextSummaryTitle}\n\n${llmSummary}`;
    tier = "llm";
  } catch (error) {
    // Provider failures can safely use the extractive fallback; an explicit
    // run abort cannot. Persisting a new summary after cancellation would make
    // the supposedly stopped run mutate session state.
    if (
      abortSignal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw error;
    }
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
