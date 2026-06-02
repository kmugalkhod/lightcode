# EPIC-03 Session Lifecycle and Resume

## Outcome

Lightcode sessions become durable work units with list, resume, delete, export, latest-session lookup, and persisted mode/permission metadata.

## Depends On

EPIC-01 and EPIC-02.

## Current Code Areas

- `packages/db/prisma/schema.prisma`
- `apps/server/src/lib/chat-store.ts`
- `apps/server/src/routes/chat-routes.ts`
- `packages/ai/src/chat-schemas.ts`
- `apps/cli/src/navigation/route-registry.ts`
- `apps/cli/src/screens/chat-screen.tsx`

## Tickets

LC-014: Extend session schema. [x]
Add persisted fields for `cwd`, `mode`, `permissionMode`, `model`, optional `title`, and timestamps needed for latest-session sorting.

LC-015: Add session list API. [x]
Return id, title, model, mode, permission mode, createdAt, updatedAt, message count, and latest user prompt preview.

LC-016: Add session resume API. [x]
Support explicit session id and `latest`. Keep route validation strict.

LC-017: Add session delete API. [x]
Delete session and messages transactionally.

LC-018: Add session export API. [x]
Export messages as JSON first. Add Markdown export after JSON is stable.

LC-019: Add CLI session views. [x]
Add session list/resume/delete/export routes or command-palette actions.

LC-020: Persist mode transitions. [x]
When plan switches to build after confirmation, update session metadata.

## Implementation Notes

- Extended `ChatSession` with `cwd`, `mode`, `permissionMode`, and `model`; `title`, `createdAt`, and `updatedAt` remain persisted and `updatedAt` is indexed for latest-session sorting.
- Added shared session schemas for list, resume/messages, delete, and JSON export validation.
- Added session list, explicit/latest resume, delete, and JSON export APIs under `/sessions`.
- Updated chat persistence to store session cwd, mode, permission mode, and model on pre-stream and finish writes.
- Added CLI `/sessions` and `/latest` navigation entries.
- Added a sessions screen with list, resume, resume latest, delete confirmation, refresh, and JSON export controls.
- Chat screen restores persisted mode and permission mode from session metadata when route state does not override them.

## Verification

- `bun run db:generate`
- `bun run db:validate`
- `bun test packages/ai/src/chat-schemas.test.ts`
- `bun test packages/ai/src/bash/command-classification.test.ts packages/ai/src/common/resolve-within-workspace.test.ts packages/ai/src/bash/bash-runtime.test.ts packages/ai/src/permissions/permission-policy.test.ts`
- `bun run typecheck`

## Acceptance Criteria

- User can list sessions from the CLI.
- User can resume the latest session.
- Chat screen restores persisted mode and permission mode.
- Exported JSON validates against a schema.
- Deleting a session removes its messages.
- `bun run typecheck` passes.

## Execute Next

After this epic, start EPIC-04 to make session metadata configurable and provider-aware.
