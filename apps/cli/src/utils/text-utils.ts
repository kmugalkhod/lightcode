export { getErrorMessage } from "@lightcode/shared";

export function truncateInline(text: string, maxLength = 96): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

/**
 * Truncate a path from the left, keeping the tail (filename) visible. Used for
 * file lists where the basename matters more than the leading directories.
 * The ellipsis is configurable so callers can pass an ASCII fallback.
 */
export function truncatePathLeft(path: string, maxLength = 40, ellipsis = "…"): string {
  if (path.length <= maxLength) {
    return path;
  }
  const keep = Math.max(0, maxLength - ellipsis.length);
  return `${ellipsis}${path.slice(path.length - keep)}`;
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

export function stripTrailingPeriod(text: string): string {
  return text.endsWith(".") ? text.slice(0, -1) : text;
}

export function getStringProperty(input: unknown, key: string): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const value = Reflect.get(input, key);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function getNumberProperty(input: unknown, key: string): number | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const value = Reflect.get(input, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
