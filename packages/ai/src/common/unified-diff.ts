import { createTwoFilesPatch } from "diff";

export const DEFAULT_DIFF_MAX_CHARS = 6_000;
const DIFF_CONTEXT_LINES = 3;

/**
 * Unified diff between two versions of a file, sized for tool output
 * (rendered as a colored diff in the TUI and pruned from old context by
 * Tier-1 optimization).
 */
export function createUnifiedDiff(
  filePath: string,
  oldText: string,
  newText: string,
  { maxChars = DEFAULT_DIFF_MAX_CHARS }: { maxChars?: number } = {},
): string {
  const patch = createTwoFilesPatch(
    filePath,
    filePath,
    oldText,
    newText,
    undefined,
    undefined,
    { context: DIFF_CONTEXT_LINES },
  );

  // Drop the "Index:"/separator preamble; keep ---/+++/@@ hunks.
  const normalized = patch.replace(/^Index:[^\n]*\n=+\n/, "");
  if (normalized.length <= maxChars) {
    return normalized.trimEnd();
  }

  const cutoff = normalized.lastIndexOf("\n", maxChars);
  const prefix = normalized.slice(0, cutoff > 0 ? cutoff : maxChars);
  return `${prefix}\n... diff truncated ...`;
}
