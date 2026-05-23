import { MAX_TOOL_TEXT_OUTPUT_CHARS } from "../constants";

export interface TruncateTextResult {
  text: string;
  truncated: boolean;
}

export function truncateText(text: string, maxChars = MAX_TOOL_TEXT_OUTPUT_CHARS): TruncateTextResult {
  if (text.length <= maxChars) {
    return {
      text,
      truncated: false,
    };
  }

  const suffix = `\n\n... output truncated to ${maxChars} characters ...`;
  const allowedLength = Math.max(0, maxChars - suffix.length);

  return {
    text: `${text.slice(0, allowedLength)}${suffix}`,
    truncated: true,
  };
}

export function toSingleLinePreview(value: unknown, maxChars = 140): string {
  let text: string;

  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars - 3)}...`;
}
