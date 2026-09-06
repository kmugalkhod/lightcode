# Web rendering refinement

The supplied DevStash explanation exposed two renderer gaps: tables were plain text, and streamed answers switched from raw text to formatted content only at completion. The old renderer produced zero tables, semantic headings, or code blocks for the test sample with an unfinished fence.

## Changes

- Replace the partial regex renderer with safe React Markdown and GitHub-flavored Markdown support. Stream and completion use the same renderer, including open code fences.
- Defer streaming Markdown updates so urgent input can render first. Existing 50ms shared chat update throttling remains unchanged.
- Increase the conversation column from 900px to 1040px and place role labels above content; keep prose at a readable 72ch measure.
- Group consecutive successful tools; expanded output is mounted on demand. Keep failures and approvals visible. Collapsed reasoning is also mounted on demand.
- Follow content resizes when pinned to the bottom and relinquish following when the reader scrolls upward.
- Reject unsafe link schemes, skip raw HTML, and omit remote images rather than making model-directed background requests.

## Verification

- Six new tests cover stream/completion markup identity, unfinished fences, nested lists, escaped table pipes, unsafe content, literal paths, and tool visibility.
- Chromium checks use synthetic DevStash content, not the user's real repository or live provider calls.
- The same table and code DOM nodes survived simulated streaming through completion. No long tasks were recorded during that small desktop streaming fixture; this is not a low-end-device or long-history performance guarantee.
- Seven completed tool calls occupy one 44px collapsed row; expanding it exposes all seven calls. Back to latest returned exactly to the bottom.
- The Markdown implementation adds approximately 160KB to the minified web JavaScript bundle (0.77MB to 0.93MB). This is a parsing/features tradeoff, not a bundle-size optimization.
- Impeccable guided the scoped spacing/typography pass; the layout detector returned no findings.

These rendering improvements are included in release 0.17.1.
