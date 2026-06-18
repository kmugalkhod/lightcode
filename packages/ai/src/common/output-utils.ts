import { DEFAULT_TOOL_TEXT_OUTPUT_CHARS } from "../constants";

export interface TruncateTextResult {
  text: string;
  truncated: boolean;
}

function omissionMarker(omitted: number): string {
  return `\n\n... [${omitted} characters omitted; re-read a line range with read_file or raise maxChars] ...\n\n`;
}

/**
 * Truncates large tool output while keeping BOTH ends — signatures/headers
 * cluster at the top, errors/results at the bottom, so head-only truncation
 * silently drops the part that often matters most. The middle marker states the
 * exact number of omitted characters and how to retrieve them, so nothing is
 * lost without a recovery path. The result is guaranteed to be <= maxChars.
 */
export function truncateText(
  text: string,
  maxChars = DEFAULT_TOOL_TEXT_OUTPUT_CHARS,
): TruncateTextResult {
  if (text.length <= maxChars) {
    return {
      text,
      truncated: false,
    };
  }

  // Reserve the marker's worst-case length (omitting the whole input has the
  // most digits) so the final string never exceeds maxChars.
  const markerReserve = omissionMarker(text.length).length;
  const usable = Math.max(0, maxChars - markerReserve);
  const headChars = Math.floor(usable * 0.7);
  const tailChars = usable - headChars;
  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(text.length - tailChars) : "";
  const omitted = text.length - head.length - tail.length;

  return {
    text: `${head}${omissionMarker(omitted)}${tail}`,
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
