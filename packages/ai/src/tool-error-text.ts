import { InvalidToolInputError, NoSuchToolError } from "ai";

/**
 * Tool failures are ordinary tool results: the model reads them and reacts.
 * They must not travel as chat-stream failures (the LIGHTCODE_ERROR envelope,
 * failure counters), and must stay short — they are shown inside the tool
 * call and replayed to the model on later turns.
 */

const toolExecutionErrors = new WeakSet<object>();
const maxToolErrorTextLength = 1_000;
const maxCauseDepth = 4;

/** Marks an error thrown while a coding tool executed. */
export function markToolExecutionError(error: unknown): void {
  if (typeof error === "object" && error !== null) {
    toolExecutionErrors.add(error);
  }
}

function truncate(text: string): string {
  return text.length > maxToolErrorTextLength
    ? `${text.slice(0, maxToolErrorTextLength)}…`
    : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Finds schema issues in an SDK validation error chain (ZodError or raw issues). */
function collectValidationIssues(cause: unknown): string[] {
  let current = cause;
  for (let depth = 0; depth < maxCauseDepth && current !== undefined; depth += 1) {
    const issues = Array.isArray(current)
      ? current
      : isRecord(current) && Array.isArray(current.issues)
        ? current.issues
        : null;
    if (issues) {
      return issues.flatMap((issue) => {
        if (!isRecord(issue)) return [];
        const path = Array.isArray(issue.path) && issue.path.length > 0
          ? issue.path.map(String).join(".")
          : "input";
        const message = typeof issue.message === "string" ? issue.message : "invalid";
        return /received undefined/i.test(message)
          ? [`missing required field "${path}"`]
          : [`${path}: ${message}`];
      });
    }
    current = isRecord(current) ? current.cause : undefined;
  }
  return [];
}

function describeInvalidInput(toolName: string, issues: readonly string[]): string {
  const details =
    issues.length > 0
      ? issues.join("; ")
      : "the arguments do not match the tool's schema";
  return truncate(
    `Invalid input for ${toolName}: ${details}. Resend the call with every required field.`,
  );
}

// The SDK reports an invalid call twice: as the error object (tool input) and
// as its message string (tool output). These match the SDK's message formats.
const invalidInputMessagePattern = /^Invalid input for tool ([^:\s]+): /;
const unavailableToolMessagePattern = /^Model tried to call unavailable tool /;
const validationIssuesMarker = "Error message: ";

/**
 * Plain text for a tool-level failure — invalid arguments, an unknown tool,
 * or an error thrown by the tool itself — or null for a genuine stream error.
 */
export function formatToolErrorText(error: unknown): string | null {
  if (InvalidToolInputError.isInstance(error)) {
    return describeInvalidInput(error.toolName, collectValidationIssues(error.cause));
  }
  if (NoSuchToolError.isInstance(error)) {
    return truncate(error.message);
  }
  if (typeof error === "string") {
    const invalidInput = error.match(invalidInputMessagePattern);
    if (invalidInput) {
      const marker = error.lastIndexOf(validationIssuesMarker);
      let issues: string[] = [];
      try {
        issues =
          marker >= 0
            ? collectValidationIssues(
                JSON.parse(error.slice(marker + validationIssuesMarker.length)),
              )
            : [];
      } catch {
        // Unparseable detail: fall back to the generic description.
      }
      return describeInvalidInput(invalidInput[1] ?? "tool", issues);
    }
    return unavailableToolMessagePattern.test(error) ? truncate(error) : null;
  }
  if (isRecord(error) && toolExecutionErrors.has(error)) {
    return truncate(error instanceof Error ? error.message : String(error));
  }
  return null;
}
