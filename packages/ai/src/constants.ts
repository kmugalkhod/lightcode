/** Hard ceiling a tool's text output may reach when the model explicitly asks. */
export const MAX_TOOL_TEXT_OUTPUT_CHARS = 12_000;
/**
 * Default text-output budget when the model doesn't specify one. Lower than the
 * ceiling to save tokens on verbose outputs; truncation is head+tail and states
 * how to retrieve the omitted middle, so accuracy is preserved.
 */
export const DEFAULT_TOOL_TEXT_OUTPUT_CHARS = 6_000;
export const MAX_TOOL_LIST_ENTRIES = 200;
export const MAX_TOOL_SEARCH_RESULTS = 200;
export const ANTHROPIC_TOOL_OPTIONAL_PARAMETER_BUDGET = 24;
/**
 * Max characters a single todo item's content may keep. Items are terse labels,
 * not paragraphs; over-length content is truncated (with a warning) so each
 * full-rewrite of the list stays small.
 */
export const TODO_CONTENT_MAX_CHARS = 200;
/**
 * Max characters for a todo item's optional activeForm — a short present-tense
 * label (e.g. "Adding tests") the UI shows for the in_progress item. Capped so
 * the full-rewrite stays small.
 */
export const TODO_ACTIVE_FORM_MAX_CHARS = 80;
/**
 * Only progress notes longer than this are elided from the provider view when
 * context pruning runs — short notes cost little and pruning them churns the
 * prompt cache for no real saving.
 */
export const PROGRESS_NOTE_PRUNE_MIN_CHARS = 200;
