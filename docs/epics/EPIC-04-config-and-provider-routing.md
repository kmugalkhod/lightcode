# EPIC-04 Config and Provider Routing

## Outcome

Lightcode can load project/user config and route model calls through Anthropic or OpenAI-compatible providers without rewriting the chat pipeline.

## Depends On

EPIC-03 Session Lifecycle and Resume.

## Current Code Areas

- `apps/server/src/routes/chat-routes.ts`
- `packages/ai/src/coding-agent.ts`
- `packages/ai/src/agent-tools.ts`
- `packages/ai/src/chat-schemas.ts`
- root `.env`

## Tickets

LC-021: Add config loader package. [x]
Create a typed config loader under `packages/ai/src/config/` or `packages/shared/src/config/` with project config `.lightcode/settings.json` and optional user config.

LC-022: Define config schema. [x]
Support `model`, `provider`, `baseUrl`, `defaultMode`, `permissionMode`, `allowedTools`, `permissions`, `sandbox`, and `maxOutputTokens`.

LC-023: Add provider registry. [x]
Abstract model creation so the server can choose Anthropic or OpenAI-compatible providers from config/env.

LC-024: Add model alias resolution. [x]
Support aliases like `haiku`, `sonnet`, `opus`, plus pass-through provider model ids.

LC-025: Persist resolved model per assistant message. [x]
Keep the current `assistantModel` storage behavior, but store the resolved model id.

LC-026: Add config diagnostics. [x]
Expose a config status payload with loaded files, selected provider, selected model, and missing credential hints.

## Implementation Notes

- Added the typed Lightcode config loader in `packages/ai/src/config/lightcode-config.ts`.
- Config is loaded from user config, project `.lightcode/settings.json`, and environment overrides, in that order of precedence.
- Added server provider routing in `apps/server/src/lib/provider-registry.ts` with Anthropic and OpenAI-compatible support.
- Added aliases for `haiku`, `sonnet`, and `opus`; provider model ids still pass through unchanged.
- Wired the chat pipeline to use the resolved configured provider/model from `apps/server/src/lib/runtime-config.ts`.
- Persisted the resolved model id in session metadata and assistant message persistence paths.
- Added `GET /config/status` for config diagnostics and missing credential hints.
- Added `@ai-sdk/openai-compatible` to the server app dependencies.

## Verification

- `bun test packages/ai/src/config/lightcode-config.test.ts`
- `bun test apps/server/src/lib/provider-registry.test.ts`
- `bun run typecheck`

## Acceptance Criteria

- Server can run with Anthropic as today.
- Server can run with an OpenAI-compatible base URL when configured.
- Invalid config fails with a useful validation error.
- Session messages record the model used.
- `bun run typecheck` passes.

## Execute Next

After this epic, start EPIC-05 so new tools can depend on config, permissions, and provider routing.
