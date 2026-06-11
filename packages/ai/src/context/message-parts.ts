import type { UIMessage } from "ai";

export type UIMessagePart = UIMessage["parts"][number];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const toolPartTypePrefix = "tool-";

export function getToolNameFromPart(part: UIMessagePart): string | null {
  if (!isRecord(part)) {
    return null;
  }

  const toolName = Reflect.get(part, "toolName");
  if (typeof toolName === "string" && toolName.trim()) {
    return toolName.trim();
  }

  if (typeof part.type === "string" && part.type.startsWith(toolPartTypePrefix)) {
    const inferred = part.type.slice(toolPartTypePrefix.length).trim();
    return inferred || null;
  }

  return null;
}

export function getTextPartContent(part: UIMessagePart): string | null {
  if (!isRecord(part)) {
    return null;
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

export function collectMessageText(message: UIMessage): string {
  return message.parts
    .map(getTextPartContent)
    .filter((partText): partText is string => Boolean(partText?.trim()))
    .join("\n")
    .trim();
}

const resolvedToolStates = new Set([
  "output-available",
  "output-error",
  "output-denied",
]);

export function hasUnresolvedToolWork(messages: readonly UIMessage[]): boolean {
  return messages.some((message) =>
    message.parts.some((part) => {
      if (!isRecord(part) || !getToolNameFromPart(part)) {
        return false;
      }

      const state = Reflect.get(part, "state");
      return !resolvedToolStates.has(typeof state === "string" ? state : "");
    }),
  );
}
