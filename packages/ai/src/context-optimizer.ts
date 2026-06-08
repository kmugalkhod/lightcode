import type { UIMessage } from "ai";
import { z } from "zod";

const contextSummaryTitle = "Lightcode context summary";
const contextSummaryMessageId = "lightcode-context-summary";
const defaultMaxInputTokens = 100_000;
const defaultPreserveRecentMessages = 4;
const defaultSummaryMaxChars = 1_200;
const estimatedCharsPerToken = 4;
const maxTimelineEntries = 8;
const maxRecentUserRequests = 3;
const maxPendingWorkItems = 3;
const maxKeyFiles = 8;
const maxToolNames = 12;

export const contextOptimizerConfigSchema = z
  .object({
    autoCompact: z.boolean().optional(),
    maxInputTokens: z.number().int().min(1).max(10_000_000).optional(),
    preserveRecentMessages: z.number().int().min(0).max(100).optional(),
    summaryMaxChars: z.number().int().min(200).max(50_000).optional(),
  })
  .strict();

export const resolvedContextOptimizerConfigSchema = z.object({
  autoCompact: z.boolean(),
  maxInputTokens: z.number().int().min(1).max(10_000_000),
  preserveRecentMessages: z.number().int().min(0).max(100),
  summaryMaxChars: z.number().int().min(200).max(50_000),
});

export type ContextOptimizerConfig = z.infer<typeof contextOptimizerConfigSchema>;
export type ResolvedContextOptimizerConfig = z.infer<
  typeof resolvedContextOptimizerConfigSchema
>;

export const defaultContextOptimizerConfig = {
  autoCompact: true,
  maxInputTokens: defaultMaxInputTokens,
  preserveRecentMessages: defaultPreserveRecentMessages,
  summaryMaxChars: defaultSummaryMaxChars,
} satisfies ResolvedContextOptimizerConfig;

export type ContextOptimizationSkipReason =
  | "disabled"
  | "below_threshold"
  | "not_enough_messages"
  | "pending_interactions"
  | "unresolved_tool_work";

export interface ContextOptimizationResult {
  messages: UIMessage[];
  compacted: boolean;
  estimatedTokens: number;
  removedMessageCount: number;
  summary: string | null;
  skipReason: ContextOptimizationSkipReason | null;
}

interface MessageCounts {
  user: number;
  assistant: number;
  system: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeContextOptimizerConfig(
  config: ContextOptimizerConfig | ResolvedContextOptimizerConfig | undefined,
): ResolvedContextOptimizerConfig {
  return resolvedContextOptimizerConfigSchema.parse({
    ...defaultContextOptimizerConfig,
    ...(config ?? {}),
  });
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function estimateTextTokens(text: string) {
  return Math.ceil(text.length / estimatedCharsPerToken) + 1;
}

export function estimateContextTokens(messages: readonly UIMessage[]): number {
  return messages.reduce((total, message) => {
    return total + estimateTextTokens(safeStringify(message));
  }, 0);
}

function getTextPartContent(part: UIMessage["parts"][number]): string | null {
  if (!isRecord(part)) {
    return null;
  }

  if (part.type === "text" && typeof part.text === "string") {
    return part.text;
  }

  if (part.type === "reasoning" && typeof Reflect.get(part, "text") === "string") {
    return Reflect.get(part, "text") as string;
  }

  const text = Reflect.get(part, "text");
  if (typeof text === "string") {
    return text;
  }

  const errorText = Reflect.get(part, "errorText");
  if (typeof errorText === "string") {
    return errorText;
  }

  return null;
}

function collectMessageText(message: UIMessage): string {
  return message.parts
    .map(getTextPartContent)
    .filter((partText): partText is string => Boolean(partText?.trim()))
    .join("\n")
    .trim();
}

function truncateInline(text: string, maxChars: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function summarizeMessage(message: UIMessage) {
  const text = collectMessageText(message);
  if (text) {
    return truncateInline(text, 160);
  }

  const toolNames = collectToolNames([message]);
  if (toolNames.length > 0) {
    return `tool activity: ${toolNames.join(", ")}`;
  }

  return truncateInline(safeStringify(message.parts), 160);
}

function countRoles(messages: readonly UIMessage[]): MessageCounts {
  return messages.reduce<MessageCounts>(
    (counts, message) => {
      if (message.role === "user") {
        counts.user += 1;
      } else if (message.role === "assistant") {
        counts.assistant += 1;
      } else {
        counts.system += 1;
      }

      return counts;
    },
    {
      user: 0,
      assistant: 0,
      system: 0,
    },
  );
}

function getToolNameFromPart(part: UIMessage["parts"][number]) {
  if (!isRecord(part)) {
    return null;
  }

  const toolName = Reflect.get(part, "toolName");
  if (typeof toolName === "string" && toolName.trim()) {
    return toolName.trim();
  }

  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    const inferred = part.type.slice("tool-".length).trim();
    return inferred || null;
  }

  return null;
}

function collectToolNames(messages: readonly UIMessage[]) {
  const names = new Set<string>();

  for (const message of messages) {
    for (const part of message.parts) {
      const name = getToolNameFromPart(part);
      if (name) {
        names.add(name);
      }
    }
  }

  return [...names].sort().slice(0, maxToolNames);
}

function collectRecentUserRequests(messages: readonly UIMessage[]) {
  return messages
    .filter((message) => message.role === "user")
    .map(collectMessageText)
    .filter((text) => text.trim().length > 0)
    .slice(-maxRecentUserRequests)
    .map((text) => truncateInline(text, 160));
}

function collectPendingWork(messages: readonly UIMessage[]) {
  const pendingTokens = [
    "todo",
    "next",
    "pending",
    "follow up",
    "remaining",
    "blocked",
    "in progress",
  ];

  return messages
    .map(collectMessageText)
    .filter((text) => {
      const normalized = text.toLowerCase();
      return pendingTokens.some((token) => normalized.includes(token));
    })
    .slice(-maxPendingWorkItems)
    .map((text) => truncateInline(text, 160));
}

function collectCurrentWork(messages: readonly UIMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = collectMessageText(messages[index]);
    if (text.trim()) {
      return truncateInline(text, 200);
    }
  }

  return null;
}

function collectStringsByKey(value: unknown, keys: ReadonlySet<string>, out: Set<string>) {
  if (typeof value === "string") {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringsByKey(entry, keys, out);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && keys.has(key.toLowerCase()) && entry.trim()) {
      out.add(entry.trim());
      continue;
    }

    collectStringsByKey(entry, keys, out);
  }
}

function normalizePathCandidate(value: string) {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.?\//, "")
    .trim()
    .replace(/[),.;:'"`\]]+$/g, "");
}

function looksLikePath(value: string) {
  return (
    value.includes("/") &&
    /\.(?:ts|tsx|js|jsx|json|md|css|html|rs|py|toml|yaml|yml|prisma|txt)$/i.test(
      value,
    )
  );
}

function collectKeyFiles(messages: readonly UIMessage[]) {
  const candidates = new Set<string>();
  const pathKeys = new Set(["path", "file", "filepath", "filename"]);

  for (const message of messages) {
    const content = `${collectMessageText(message)}\n${safeStringify(message.parts)}`;
    for (const match of content.matchAll(/[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+/g)) {
      const candidate = normalizePathCandidate(match[0]);
      if (looksLikePath(candidate)) {
        candidates.add(candidate);
      }
    }

    collectStringsByKey(message.parts, pathKeys, candidates);
  }

  return [...candidates]
    .map(normalizePathCandidate)
    .filter(looksLikePath)
    .sort()
    .slice(0, maxKeyFiles);
}

function extractExistingContextSummary(message: UIMessage | undefined) {
  if (!message || message.role !== "system") {
    return null;
  }

  const text = collectMessageText(message);
  if (!text.startsWith(contextSummaryTitle)) {
    return null;
  }

  return text.trim();
}

function extractSummaryHighlights(summary: string) {
  const lines: string[] = [];
  let inTimeline = false;

  for (const line of summary.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed === contextSummaryTitle ||
      trimmed === "- Previously compacted context:" ||
      trimmed === "- Key timeline:"
    ) {
      if (trimmed === "- Key timeline:") {
        inTimeline = true;
      }
      continue;
    }

    if (inTimeline && trimmed.startsWith("- ")) {
      continue;
    }

    if (trimmed.startsWith("- ")) {
      lines.push(trimmed);
    }
  }

  return lines.slice(0, 8);
}

function addSection(lines: string[], title: string, items: readonly string[]) {
  if (items.length === 0) {
    return;
  }

  lines.push(`- ${title}:`);
  for (const item of items) {
    lines.push(`  - ${item}`);
  }
}

function buildContextSummary({
  existingSummary,
  removedMessages,
  summaryMaxChars,
}: {
  existingSummary: string | null;
  removedMessages: readonly UIMessage[];
  summaryMaxChars: number;
}) {
  const counts = countRoles(removedMessages);
  const lines = [
    contextSummaryTitle,
    "",
    "This session was compacted to keep the provider context window stable.",
    `- Scope: ${removedMessages.length} earlier messages compacted (user=${counts.user}, assistant=${counts.assistant}, system=${counts.system}).`,
  ];

  if (existingSummary) {
    addSection(lines, "Previously compacted context", extractSummaryHighlights(existingSummary));
  }

  addSection(lines, "Recent user requests", collectRecentUserRequests(removedMessages));
  addSection(lines, "Pending work", collectPendingWork(removedMessages));

  const keyFiles = collectKeyFiles(removedMessages);
  if (keyFiles.length > 0) {
    lines.push(`- Key files referenced: ${keyFiles.join(", ")}.`);
  }

  const toolNames = collectToolNames(removedMessages);
  if (toolNames.length > 0) {
    lines.push(`- Tools used: ${toolNames.join(", ")}.`);
  }

  const currentWork = collectCurrentWork(removedMessages);
  if (currentWork) {
    lines.push(`- Current work: ${currentWork}`);
  }

  addSection(
    lines,
    "Key timeline",
    removedMessages.slice(-maxTimelineEntries).map((message) => {
      return `${message.role}: ${summarizeMessage(message)}`;
    }),
  );

  return compressSummary(lines.join("\n"), summaryMaxChars);
}

function compressSummary(summary: string, maxChars: number) {
  const normalizedLines: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of summary.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trimEnd();
    const dedupeKey = line.trim().toLowerCase();
    if (dedupeKey && seen.has(dedupeKey)) {
      continue;
    }

    if (dedupeKey) {
      seen.add(dedupeKey);
    }
    normalizedLines.push(line);
  }

  const normalized = normalizedLines.join("\n").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const omission = "\n- Additional summary detail omitted after reaching context budget.";
  const allowedLength = Math.max(0, maxChars - omission.length);
  let end = allowedLength;
  while (end > 0 && !normalized.slice(0, end).endsWith("\n") && normalized[end] !== "\n") {
    end -= 1;
  }

  const prefix =
    end > contextSummaryTitle.length
      ? normalized.slice(0, end).trimEnd()
      : normalized.slice(0, allowedLength).trimEnd();

  return `${prefix}${omission}`;
}

function createSummaryMessage(summary: string): UIMessage {
  return {
    id: contextSummaryMessageId,
    role: "system",
    parts: [
      {
        type: "text",
        text: summary,
      },
    ],
  };
}

function hasUnresolvedToolWork(messages: readonly UIMessage[]) {
  return messages.some((message) =>
    message.parts.some((part) => {
      if (!isRecord(part) || !getToolNameFromPart(part)) {
        return false;
      }

      const state = Reflect.get(part, "state");
      return ![
        "output-available",
        "output-error",
        "output-denied",
      ].includes(typeof state === "string" ? state : "");
    }),
  );
}

export function optimizeContextMessages({
  messages,
  config,
  pendingInteractionCount = 0,
}: {
  messages: readonly UIMessage[];
  config?: ContextOptimizerConfig | ResolvedContextOptimizerConfig;
  pendingInteractionCount?: number;
}): ContextOptimizationResult {
  const resolvedConfig = normalizeContextOptimizerConfig(config);
  const estimatedTokens = estimateContextTokens(messages);

  if (!resolvedConfig.autoCompact) {
    return {
      messages: [...messages],
      compacted: false,
      estimatedTokens,
      removedMessageCount: 0,
      summary: null,
      skipReason: "disabled",
    };
  }

  if (estimatedTokens < resolvedConfig.maxInputTokens) {
    return {
      messages: [...messages],
      compacted: false,
      estimatedTokens,
      removedMessageCount: 0,
      summary: null,
      skipReason: "below_threshold",
    };
  }

  if (pendingInteractionCount > 0) {
    return {
      messages: [...messages],
      compacted: false,
      estimatedTokens,
      removedMessageCount: 0,
      summary: null,
      skipReason: "pending_interactions",
    };
  }

  if (hasUnresolvedToolWork(messages)) {
    return {
      messages: [...messages],
      compacted: false,
      estimatedTokens,
      removedMessageCount: 0,
      summary: null,
      skipReason: "unresolved_tool_work",
    };
  }

  const existingSummary = extractExistingContextSummary(messages[0]);
  const compactedPrefixLength = existingSummary ? 1 : 0;
  const compactableMessageCount = messages.length - compactedPrefixLength;

  if (compactableMessageCount <= resolvedConfig.preserveRecentMessages) {
    return {
      messages: [...messages],
      compacted: false,
      estimatedTokens,
      removedMessageCount: 0,
      summary: null,
      skipReason: "not_enough_messages",
    };
  }

  const keepFrom =
    resolvedConfig.preserveRecentMessages === 0
      ? messages.length
      : Math.max(
          compactedPrefixLength,
          messages.length - resolvedConfig.preserveRecentMessages,
        );
  const removedMessages = messages.slice(compactedPrefixLength, keepFrom);
  const preservedMessages = messages.slice(keepFrom);

  if (removedMessages.length === 0) {
    return {
      messages: [...messages],
      compacted: false,
      estimatedTokens,
      removedMessageCount: 0,
      summary: null,
      skipReason: "not_enough_messages",
    };
  }

  const summary = buildContextSummary({
    existingSummary,
    removedMessages,
    summaryMaxChars: resolvedConfig.summaryMaxChars,
  });

  return {
    messages: [createSummaryMessage(summary), ...preservedMessages],
    compacted: true,
    estimatedTokens,
    removedMessageCount: removedMessages.length,
    summary,
    skipReason: null,
  };
}

