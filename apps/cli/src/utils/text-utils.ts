export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function truncateInline(text: string, maxLength = 96): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
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
