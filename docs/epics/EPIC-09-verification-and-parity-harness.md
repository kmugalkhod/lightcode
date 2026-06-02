# EPIC-09 Verification and Parity Harness

## Outcome

Lightcode has a deterministic verification harness that protects streaming, tool loops, permission prompts, resume behavior, and extension surfaces.

## Depends On

EPIC-08 Subagents and Worker Control Plane.

## Current Code Areas

- `packages/ai/src/agent-tools-schema-preflight.test.ts`
- `apps/server/src/routes/chat-routes.ts`
- `packages/ai/src/react/use-coding-session-chat.ts`
- `packages/ai/src/runtime-registry.ts`
- `package.json`

## Tickets

LC-055: Add mock provider. [x]
Create a deterministic provider that streams text, tool calls, tool-call deltas, failures, and recoverable disconnects.

LC-056: Add tool-loop scenarios.
Cover streaming text, read-file round trip, grep result handling, write-file allowed, write-file denied, bash approved, bash denied, and multi-tool turns.

LC-057: Add plan-mode scenarios.
Cover request-user-input, proposed-plan confirmation, revise-plan path, accept-plan path, and switch-to-build implementation handoff.

LC-058: Add session scenarios.
Cover create, list, latest resume, export, delete, stale revision skip, and invalid persisted message validation.

LC-059: Add provider/config scenarios.
Cover missing credentials, invalid config, Anthropic route, OpenAI-compatible route, and provider schema rejection.

LC-060: Add extension smoke scenarios.
Cover skill load, MCP degraded status, MCP tool call denied/approved, plugin hook deny, and subagent spawn.

LC-061: Add CI-friendly scripts.
Add scripts for `test`, `test:parity`, and any targeted Bun tests needed by earlier epics.

## Implementation Notes

- Added a deterministic parity mock provider fixture using the installed AI SDK V3 mock model surface.
- Added scenarios for streaming text, tool calls, streamed tool-call input deltas, provider failures, and recoverable disconnects.
- Added the initial `test:parity` script targeting parity harness tests. Broader `test` script coverage remains for LC-061.
- EPIC-08 is not fully complete yet, so subagent spawn smoke coverage in LC-060 remains blocked on the worker/tool lifecycle tickets.

## Verification

- `bun run test:parity`
- `bun run typecheck`

## Acceptance Criteria

- The harness runs without live provider credentials.
- The harness can simulate streaming and tool calls deterministically.
- Permission approval and denial paths are covered.
- Resume/session lifecycle is covered.
- `bun run typecheck`, `bun run tool-schema:check`, and `bun run test:parity` pass.

## Execute Next

After this epic, use the harness to drive smaller release milestones instead of adding large feature batches without coverage.
