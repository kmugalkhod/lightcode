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
