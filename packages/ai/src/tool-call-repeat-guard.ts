/**
 * Weak models fall into loops where they call the same read-only tool with the
 * same arguments over and over (often after a failed edit), making no progress
 * until the step budget runs out. This guard detects identical CONSECUTIVE calls
 * within a turn and throws a corrective error on the Nth one, breaking the loop
 * and telling the model to act on what it already has.
 *
 * Consecutive-only (reset on any different call) so a legitimate
 * read → edit → read verify cycle never trips it.
 */

/** Read-only / idempotent tools whose identical repeats are always pointless. */
const guardedTools = new Set<string>([
  "read_file",
  "list_files",
  "glob_search",
  "grep",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
]);

export const REPEAT_THRESHOLD = 3;
const MAX_TURNS_TRACKED = 8;

export class RepeatedToolCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepeatedToolCallError";
  }
}

const lastCallByTurn = new Map<string, { signature: string; count: number }>();

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Throws {@link RepeatedToolCallError} when a guarded tool is called with
 * identical arguments {@link REPEAT_THRESHOLD} times in a row within `turnKey`.
 * No-op for non-guarded tools or when no `turnKey` is available.
 */
export function assertNotRepeatingToolCall(
  toolName: string,
  input: unknown,
  turnKey: string | undefined,
): void {
  if (!turnKey || !guardedTools.has(toolName)) {
    return;
  }

  const signature = `${toolName}:${stableStringify(input)}`;
  const previous = lastCallByTurn.get(turnKey);
  const count =
    previous && previous.signature === signature ? previous.count + 1 : 1;

  lastCallByTurn.set(turnKey, { signature, count });

  // Bound memory: drop the oldest tracked turn once over the cap.
  if (lastCallByTurn.size > MAX_TURNS_TRACKED) {
    const oldest = lastCallByTurn.keys().next().value;
    if (oldest !== undefined) {
      lastCallByTurn.delete(oldest);
    }
  }

  if (count >= REPEAT_THRESHOLD) {
    throw new RepeatedToolCallError(
      `You have called ${toolName} with identical arguments ${count} times in a row and the result has not changed. ` +
        "Stop repeating it — use the information already in this conversation and take the next concrete action " +
        "(make your edit, or call a different tool).",
    );
  }
}

/** Test helper: clear all tracked turns. */
export function resetToolCallRepeatGuard(): void {
  lastCallByTurn.clear();
}
