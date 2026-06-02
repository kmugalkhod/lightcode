# EPIC-08 Subagents and Worker Control Plane

## Outcome

Lightcode can delegate background coding tasks to controlled subagents with isolated sessions, restricted tools, and visible progress.

## Depends On

EPIC-07 Skills MCP and Plugins.

## Current Code Areas

- `packages/ai/src/coding-agent.ts`
- `packages/ai/src/runtime-registry.ts`
- `apps/server/src/routes/chat-routes.ts`
- `apps/server/src/lib/chat-store.ts`
- `packages/db/prisma/schema.prisma`

## Tickets

LC-048: Add task/subagent database models. [x]
Persist task id, parent session id, prompt, status, mode, model, allowed tools, output, error, and timestamps.

LC-049: Add subagent tool subsets.
Define tool profiles such as `explore`, `plan`, `implement`, and `verify`.

LC-050: Add `agent` tool.
Let the main agent spawn a background subagent with description, prompt, profile, and optional model.

LC-051: Add worker lifecycle APIs.
Create, get, list, cancel, and retrieve output.

LC-052: Add CLI task view.
Show running/completed/failed subagents and allow opening outputs.

LC-053: Add progress and terminal-state classification.
Classify running, completed, failed, blocked-on-approval, blocked-on-provider, and cancelled.

LC-054: Add safety boundaries.
Subagents must inherit or reduce parent permissions, never expand them without explicit approval.

## Implementation Notes

- Added `SubagentTaskStatus` and `SubagentTask` to the Prisma schema, linked to parent chat sessions with cascade cleanup.
- Added shared Zod schemas for subagent task create requests, lifecycle statuses, allowed tools, output, and list responses.
- Added a server-side `subagent-task-store` with create, load, list, and update helpers that parse persisted records at the boundary.

## Verification

- `bun run db:generate`
- `bun test packages/ai/src/subagent-schemas.test.ts`
- `bun run db:validate`
- `bun run typecheck`

## Acceptance Criteria

- A main session can spawn a read-only exploration subagent.
- Subagent output is persisted and resumable.
- Subagents cannot use tools outside their profile.
- Parent session can inspect task state.
- `bun run typecheck` passes.

## Execute Next

After this epic, start EPIC-09 to lock behavior down with deterministic parity coverage.
