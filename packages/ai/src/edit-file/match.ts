/**
 * Robust search/replace matching for `edit_file`.
 *
 * The model builds its search text from `read_file` output, which is always
 * LF-normalized. The file on disk may be CRLF, and the model's whitespace can
 * drift slightly from the source. A strict literal match therefore fails
 * constantly (every CRLF file; any indentation/trailing-space drift). This
 * matcher tries progressively more tolerant strategies, stopping at the first
 * that matches, and always preserves the file's original line endings.
 *
 * Safety: when `replaceAll` is false the chosen strategy must match exactly one
 * place — an ambiguous match throws rather than silently editing the wrong spot.
 */

export type EditStrategy = "exact" | "eol-normalized" | "whitespace-flexible";

export interface ApplyEditResult {
  updatedContent: string;
  replacements: number;
  strategy: EditStrategy;
}

/** Thrown when the search text cannot be applied (no match or ambiguous). */
export class EditMatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditMatchError";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "\r\n" when the file is predominantly CRLF, else "\n". */
function detectEol(content: string): "\r\n" | "\n" {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  if (crlf === 0) {
    return "\n";
  }
  const lfOnly = (content.match(/(?<!\r)\n/g) ?? []).length;
  return crlf >= lfOnly ? "\r\n" : "\n";
}

function toLf(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function countLiteral(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) {
      break;
    }
    count += 1;
    from = index + needle.length;
  }
  return count;
}

interface Range {
  start: number;
  end: number;
}

/** Replaces the given (non-overlapping, ascending) ranges with `replacement`. */
function spliceRanges(
  content: string,
  ranges: readonly Range[],
  replacement: string,
): string {
  let out = "";
  let cursor = 0;
  for (const range of ranges) {
    out += content.slice(cursor, range.start) + replacement;
    cursor = range.end;
  }
  return out + content.slice(cursor);
}

/** Literal (exact-substring) match; `$` in `replace` is never interpreted. */
function literalRanges(content: string, search: string): Range[] {
  const ranges: Range[] = [];
  let from = 0;
  for (;;) {
    const index = content.indexOf(search, from);
    if (index === -1) {
      break;
    }
    ranges.push({ start: index, end: index + search.length });
    from = index + search.length;
  }
  return ranges;
}

/**
 * Builds a regex that matches `search` allowing per-line differences in leading
 * indentation and trailing whitespace (the most common LLM drift). Anchored to
 * whole lines so it can't match a fragment mid-line.
 */
function buildFlexibleRegex(searchLf: string): RegExp | null {
  if (!searchLf.trim()) {
    return null;
  }
  const linePatterns = searchLf.split("\n").map((line) => {
    const core = line.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
    return `[ \\t]*${escapeRegExp(core)}[ \\t]*`;
  });
  // (?<=^|\n) ... (?=\n|$) keeps each match aligned to line boundaries.
  return new RegExp(`(?<=^|\\n)${linePatterns.join("\\n")}(?=\\n|$)`, "g");
}

function regexRanges(content: string, regex: RegExp): Range[] {
  const ranges: Range[] = [];
  regex.lastIndex = 0;
  for (;;) {
    const match = regex.exec(content);
    if (!match) {
      break;
    }
    if (match[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    ranges.push({ start: match.index, end: match.index + match[0].length });
    regex.lastIndex = match.index + match[0].length;
  }
  return ranges;
}

/**
 * Applies one resolved set of match ranges, enforcing the uniqueness guard for
 * single (non-replaceAll) edits.
 */
function applyRanges(
  content: string,
  ranges: Range[],
  replacement: string,
  replaceAll: boolean,
  strategy: EditStrategy,
): ApplyEditResult | null {
  if (ranges.length === 0) {
    return null;
  }
  if (!replaceAll && ranges.length > 1) {
    throw new EditMatchError(
      `The search text matches ${ranges.length} places. Add surrounding lines to make it unique, or pass replaceAll: true to change every occurrence.`,
    );
  }
  const targetRanges = replaceAll ? ranges : [ranges[0]];
  return {
    updatedContent: spliceRanges(content, targetRanges, replacement),
    replacements: targetRanges.length,
    strategy,
  };
}

/**
 * Finds and applies `search` → `replace` in `original` using the most tolerant
 * strategy needed. Returns the rewritten content (with original EOL preserved),
 * the number of replacements, and which strategy matched. Throws
 * {@link EditMatchError} when nothing matches or the match is ambiguous.
 */
export function applyEdit(
  original: string,
  search: string,
  replace: string,
  replaceAll: boolean,
): ApplyEditResult {
  if (!search) {
    throw new EditMatchError("Search text must not be empty.");
  }

  // Tier 1 — exact match against the raw on-disk content.
  const exact = applyRanges(
    original,
    literalRanges(original, search),
    replace,
    replaceAll,
    "exact",
  );
  if (exact) {
    return exact;
  }

  const eol = detectEol(original);
  const originalLf = toLf(original);
  const searchLf = toLf(search);
  const replaceLf = toLf(replace);
  const restoreEol = (lf: string): string =>
    eol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;

  // Tier 2 — ignore line-ending differences (the CRLF fix).
  const normalized = applyRanges(
    originalLf,
    literalRanges(originalLf, searchLf),
    replaceLf,
    replaceAll,
    "eol-normalized",
  );
  if (normalized) {
    return { ...normalized, updatedContent: restoreEol(normalized.updatedContent) };
  }

  // Tier 3 — ignore leading-indentation / trailing-whitespace drift.
  const flexibleRegex = buildFlexibleRegex(searchLf);
  if (flexibleRegex) {
    const flexible = applyRanges(
      originalLf,
      regexRanges(originalLf, flexibleRegex),
      replaceLf,
      replaceAll,
      "whitespace-flexible",
    );
    if (flexible) {
      return { ...flexible, updatedContent: restoreEol(flexible.updatedContent) };
    }
  }

  throw new EditMatchError(
    "No match for the search text. Line-ending and surrounding-whitespace differences are tolerated automatically, so a remaining mismatch means the file content itself differs — re-read the file and copy the exact lines you want to change.",
  );
}

/** Re-exported for callers that report occurrence counts. */
export { countLiteral };
