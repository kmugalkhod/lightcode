export function getErrorMessage(
  error: unknown,
  fallback = "Unknown error",
): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  // Providers report mid-stream failures as plain JSON objects, e.g.
  // OpenRouter's `{ code: 402, message: "...", metadata: {...} }`.
  const message =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "message")
      : undefined;
  if (typeof message === "string" && message.trim()) {
    return message;
  }

  return fallback;
}
