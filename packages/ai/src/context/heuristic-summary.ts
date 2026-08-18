import type { UIMessage } from "ai";
import { safeStringify } from "./estimate";
import {
  collectMessageText,
  getToolNameFromPart,
  isRecord,
} from "./message-parts";

export const contextSummaryTitle = "Lightcode context summary";
export const contextSummaryMessageId = "lightcode-context-summary";

const maxTimelineEntries = 8;
const maxRecentUserRequests = 3;
const maxPendingWorkItems = 3;
const maxKeyFiles = 8;
const maxToolNames = 12;
const maxDecisionItems = 4;
const maxToolEvidenceItems = 6;

interface MessageCounts {
  user: number;
  assistant: number;
  system: number;
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

function collectDecisionsAndConstraints(messages: readonly UIMessage[]) {
  const decisionTokens = [
    "approve",
    "decision",
    "must",
    "require",
    "constraint",
    "do not",
    "don't",
    "never",
    "permission",
  ];

  return messages
    .map(collectMessageText)
    .filter((text) => {
      const normalized = text.toLowerCase();
      return decisionTokens.some((token) => normalized.includes(token));
    })
    .slice(-maxDecisionItems)
    .map((text) => truncateInline(text, 220));
}

function collectToolEvidence(messages: readonly UIMessage[]) {
  const evidence: string[] = [];
  const outcomeTokens = [
    "pass",
    "fail",
    "error",
    "test",
    "blocked",
    "denied",
    "cancel",
  ];

  for (const message of messages) {
    for (const part of message.parts) {
      const toolName = getToolNameFromPart(part);
      if (!toolName || !isRecord(part)) {
        continue;
      }
      const state = Reflect.get(part, "state");
      const error = Reflect.get(part, "errorText") ?? Reflect.get(part, "error");
      const output = Reflect.get(part, "output");
      const approval = Reflect.get(part, "approval");
      const detail = error ?? approval ?? output;
      const serialized = detail === undefined ? "" : safeStringify(detail);
      const normalized = `${String(state ?? "")} ${serialized}`.toLowerCase();
      const material =
        toolName === "bash" ||
        normalized.includes("approval") ||
        outcomeTokens.some((token) => normalized.includes(token));
      if (!material) {
        continue;
      }

      evidence.push(
        `${toolName}${typeof state === "string" ? ` [${state}]` : ""}${
          serialized ? `: ${truncateInline(serialized, 260)}` : ""
        }`,
      );
    }
  }

  return evidence.slice(-maxToolEvidenceItems);
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

function collectStringsByKey(
  value: unknown,
  keys: ReadonlySet<string>,
  out: Set<string>,
) {
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

/**
 * Extractive fallback summary used when LLM compaction is unavailable.
 */
export function buildContextSummary({
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
    addSection(
      lines,
      "Previously compacted context",
      extractSummaryHighlights(existingSummary),
    );
  }

  addSection(lines, "Recent user requests", collectRecentUserRequests(removedMessages));
  addSection(
    lines,
    "Decisions, constraints, and approvals",
    collectDecisionsAndConstraints(removedMessages),
  );
  addSection(lines, "Pending work", collectPendingWork(removedMessages));

  const keyFiles = collectKeyFiles(removedMessages);
  if (keyFiles.length > 0) {
    lines.push(`- Key files referenced: ${keyFiles.join(", ")}.`);
  }

  const toolNames = collectToolNames(removedMessages);
  if (toolNames.length > 0) {
    lines.push(`- Tools used: ${toolNames.join(", ")}.`);
  }

  addSection(
    lines,
    "Tests, tool errors, and approval outcomes",
    collectToolEvidence(removedMessages),
  );

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

export function compressSummary(summary: string, maxChars: number) {
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

export function createSummaryMessage(summary: string): UIMessage {
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
