# EPIC-06 Diagnostics and Slash Commands

## Outcome

Lightcode has user-facing operational commands for status, doctor checks, sessions, config, tools, permissions, and sandbox state.

## Depends On

EPIC-05 Expanded Tool Surface.

## Current Code Areas

- `apps/cli/src/navigation/route-registry.ts`
- `apps/cli/src/commands/command-registry.ts`
- `apps/cli/src/commands/slash-page-menu.tsx`
- `apps/server/src/routes/root-routes.ts`
- `apps/server/src/app.ts`

## Tickets

LC-034: Add diagnostics API. [x]
Expose server health, provider health, database health, config status, active model, and feature flags.

LC-035: Add `/status`. [x]
Show current session, model, mode, permission mode, cwd, message count, tool count, DB status, and pending approvals.

LC-036: Add `/doctor`. [x]
Run startup checks for server, DB, model credentials, provider access, tool schema, workspace access, and config validity.

LC-037: Add `/permissions`. [x]
Show current mode, allowed tools, denied tools, ask rules, and pending approvals.

LC-038: Add `/sessions`. [x]
List, resume, delete, and export sessions using EPIC-03 APIs.

LC-039: Add `/tools`. [x]
List tools, requirements, availability, and provider schema status.

LC-040: Add `/config`. [x]
Show loaded config files and effective config values without leaking secrets.

## Implementation Notes

- Added typed diagnostic response schemas in `packages/ai/src/diagnostics-schemas.ts`.
- Added `/diagnostics/status`, `/diagnostics/doctor`, `/diagnostics/tools`, and `/diagnostics/permissions` server routes.
- Reused existing `/config/status` for the config page and validated it client-side with `lightcodeConfigStatusSchema`.
- Added slash page routes for `/status`, `/doctor`, `/permissions`, `/sessions`, `/tools`, and `/config`.
- Added a reusable CLI diagnostics screen that validates all server payloads before rendering.
- `/status` and `/permissions` carry active chat context when launched as exact slash commands from a chat session.
- Diagnostics return missing-credential hints and config file paths, but never return API key or token values.

## Verification

- `bun run --cwd apps/server typecheck`
- `bun run --cwd apps/cli typecheck`
- `bun run typecheck`

## Acceptance Criteria

- Slash menu includes status, doctor, sessions, tools, config, and permissions.
- Diagnostics never print secret values.
- JSON-like server payloads are schema validated on the client.
- `bun run typecheck` passes.

## Execute Next

After this epic, start EPIC-07 to add extension surfaces.
