# EPIC-05 Expanded Tool Surface

## Outcome

Lightcode gains the core tools expected from a coding agent beyond basic file operations.

## Depends On

EPIC-04 Config and Provider Routing.

## Current Code Areas

- `packages/ai/src/agent-tools.ts`
- `packages/ai/src/coding-agent.ts`
- `packages/ai/src/runtime-registry.ts`
- `packages/ai/src/*/schema.ts`
- `packages/ai/src/*/runtime.ts`

## Tickets

LC-027: Add `glob_search`. [x]
Use workspace-safe globbing with result limits and hidden-directory rules.

LC-028: Add structured git tools. [x]
Add `git_status`, `git_diff`, `git_log`, `git_show`, and later `git_blame`. Prefer structured output over raw bash.

LC-029: Add `todo_write`. [x]
Persist a session-scoped task list and render it in chat/status surfaces.

LC-030: Add `tool_search`. [x]
Expose discoverable tool metadata and let the model search for tools by name/keyword.

LC-031: Add `web_fetch`. [x]
Fetch a URL, normalize text, apply size limits, and return cited metadata. Keep web access behind config and permission rules.

LC-032: Add `web_search`. [x]
Implement after `web_fetch`. Start with a provider or search API abstraction rather than scraping brittle HTML.

LC-033: Add notebook editing later in this epic. [ ]
Only add `notebook_edit` after core git/todo/search tools are stable.

## Implementation Notes

- Added `glob_search` with workspace boundary enforcement, result limits, hidden-directory handling, and default heavy-directory ignores.
- Added structured git tools: `git_status`, `git_diff`, `git_log`, and `git_show`, all using `git` argv execution instead of shell strings.
- Added `todo_write` with session-scoped persistence under `.lightcode/todos/<session>.json` and a CLI todo status card.
- Added `tool_search` over the active Lightcode tool catalog, including permission mode and active mode metadata.
- Added `web_fetch` with timeout support, normalized text extraction, HTML title extraction, source metadata, and bounded output.
- Added `web_search` behind a provider abstraction for Brave or Tavily API keys; without a configured provider it returns a structured `not_configured` result instead of scraping HTML.
- Registered all new tools in the AI SDK tool catalog, runtime registry, permission requirements, mode active-tool lists, and schema preflight.
- Reduced provider-facing optional schema fields so Anthropic active tool schemas stay under the 24 optional-parameter request limit.
- Strengthened schema preflight to count optional fields recursively and across each active mode, catching provider grammar-limit failures locally.
- Cross-checked `D:\Self-Project\claw-code` before the Anthropic complexity fix:
  - `rust/crates/api/src/types.rs` keeps `tools` and `tool_choice` optional.
  - `rust/crates/tools/src/lib.rs` filters tool definitions through `allowedTools` aliases before request construction.
  - `rust/crates/rusty-claude-cli/src/main.rs` only sends tool definitions/tool choice when tools are enabled.
- Added reference-aligned dynamic active-tool selection so casual/general prompts send no tools, coding prompts send compact relevant subsets, and zero-tool agent turns omit the tool catalog instead of sending an empty tool list with `tool_choice: auto`.
- Capped provider-facing active tools to a compact Anthropic-safe set, prioritizing core read/edit/shell tools before nice-to-have git/todo/search tools.
- `notebook_edit` remains pending until the new core tool surface has had CLI/manual usage time.

## Verification

- `bun test packages/ai/src/glob-search/glob-search-runtime.test.ts packages/ai/src/git/git-runtime.test.ts packages/ai/src/todo-write/todo-write-runtime.test.ts packages/ai/src/tool-search/tool-search-runtime.test.ts packages/ai/src/web-fetch/web-fetch-runtime.test.ts packages/ai/src/web-search/web-search-runtime.test.ts`
- `bun test packages/ai/src/coding-agent-tool-selection.test.ts`
- `bun run tool-schema:check`
- `bun run typecheck`

## Acceptance Criteria

- Every tool has runtime schema, provider schema, output schema, runtime implementation, tests, and permission requirement.
- Tool schema preflight passes.
- Tool failures return model-readable structured errors.
- `bun run typecheck` and `bun run tool-schema:check` pass.

## Execute Next

After this epic, start EPIC-06 to expose these capabilities through diagnostics and slash-style commands.
