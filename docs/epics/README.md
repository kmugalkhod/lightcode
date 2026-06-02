# Lightcode Claw-Parity Epic Tickets

This folder turns the Claw Code comparison into executable Lightcode backlog. Execute the epics in numeric order unless a ticket explicitly says it can run in parallel.

## Sequential Execution Order

1. [EPIC-01 Runtime Permission Policy](./EPIC-01-runtime-permission-policy.md)
2. [EPIC-02 Workspace Boundary and Shell Safety](./EPIC-02-workspace-boundary-and-shell-safety.md)
3. [EPIC-03 Session Lifecycle and Resume](./EPIC-03-session-lifecycle-and-resume.md)
4. [EPIC-04 Config and Provider Routing](./EPIC-04-config-and-provider-routing.md)
5. [EPIC-05 Expanded Tool Surface](./EPIC-05-expanded-tool-surface.md)
6. [EPIC-06 Diagnostics and Slash Commands](./EPIC-06-diagnostics-and-slash-commands.md)
7. [EPIC-07 Skills MCP and Plugins](./EPIC-07-skills-mcp-and-plugins.md)
8. [EPIC-08 Subagents and Worker Control Plane](./EPIC-08-subagents-and-worker-control-plane.md)
9. [EPIC-09 Verification and Parity Harness](./EPIC-09-verification-and-parity-harness.md)

## Execution Rules

- Finish all tickets in one epic before starting the next epic.
- Keep each ticket scoped to the named files and nearby modules unless the implementation exposes a real missing boundary.
- Add tests inside the same epic that changes behavior.
- Run `bun run typecheck` after each epic.
- Run `bun run tool-schema:check` whenever tool schemas change.
- Update this folder when scope changes so the backlog remains the source of truth.

## Current Baseline

Lightcode already has streaming chat, plan/build modes, proposed-plan confirmation, request-user-input handling, persisted chat messages, and UI-level approval for risky tools.

The main gaps are runtime permission enforcement, safer shell/file execution, richer sessions, config/provider routing, expanded tools, diagnostics, MCP/plugins/skills, subagents, and a deterministic verification harness.

## Release Gates

Phase 1 gate after EPIC-02:
`bun run typecheck` passes, plan mode cannot mutate files, risky tools require policy-driven approval, and workspace escape attempts are blocked.

Phase 2 gate after EPIC-06:
sessions can be listed/resumed/exported, config can select model/provider/mode, core tools are discoverable, and status/doctor surfaces report actionable state.

Phase 3 gate after EPIC-09:
MCP/skills/plugins/subagents have smoke coverage, and a mock-provider harness verifies streaming, tool loops, approvals, and resume behavior.
