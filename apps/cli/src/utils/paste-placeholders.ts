/**
 * Long pastes are collapsed in the input box to a short placeholder (like
 * Claude Code's `[Pasted text #1 +42 lines]`) so the textarea stays readable.
 * The full text is held aside and spliced back in at submit time. These helpers
 * are pure so the collapse/expand round-trip can be unit-tested without a TUI.
 */

/** Pastes with more than this many lines collapse to a placeholder. */
export const PASTE_PLACEHOLDER_LINE_THRESHOLD = 5;
/** Pastes longer than this many characters collapse to a placeholder. */
export const PASTE_PLACEHOLDER_CHAR_THRESHOLD = 400;

/** Matches a rendered placeholder and captures its paste number. */
export const PASTE_PLACEHOLDER_PATTERN = /\[Pasted text #(\d+) \+\d+ lines\]/g;

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return text.split(/\r\n|\r|\n/).length;
}

/**
 * A paste collapses when it is genuinely large — either many lines or a long
 * single blob. Small pastes flow straight into the textarea unchanged.
 */
export function shouldCollapsePaste(text: string): boolean {
  return (
    countLines(text) > PASTE_PLACEHOLDER_LINE_THRESHOLD ||
    text.length > PASTE_PLACEHOLDER_CHAR_THRESHOLD
  );
}

/** The short label shown in place of a collapsed paste. */
export function formatPastePlaceholder(index: number, text: string): string {
  return `[Pasted text #${index} +${countLines(text)} lines]`;
}

/**
 * Replace every intact placeholder with its stored full text. Placeholders the
 * user has edited or deleted no longer match and are simply left as-is, so the
 * expansion never reintroduces a paste the user removed.
 */
export function expandPastePlaceholders(
  text: string,
  store: ReadonlyMap<number, string>,
): string {
  return text.replace(PASTE_PLACEHOLDER_PATTERN, (match, rawIndex) => {
    const stored = store.get(Number(rawIndex));
    return stored ?? match;
  });
}
