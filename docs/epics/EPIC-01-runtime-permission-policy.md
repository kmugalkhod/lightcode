# EPIC-01 Runtime Permission Policy

## Outcome

Lightcode has a real permission engine enforced before tool execution. UI approval becomes one presentation of policy decisions, not the only safety mechanism.

## Depends On

None. This must be first because later shell, session, config, MCP, and subagent work all depend on a common permission contract.

## Current Code Areas

- `packages/ai/src/agent-tools.ts`
- `packages/ai/src/runtime-registry.ts`
- `packages/ai/src/react/use-coding-session-chat.ts`
- `packages/ai/src/coding-agent-modes.ts`
- `apps/cli/src/components/chat/chat-tool-approval-card.tsx`

## Tickets

LC-001: Add permission domain types. [x]
Create `packages/ai/src/permissions/` with `PermissionMode`, `PermissionOutcome`, `PermissionPolicy`, `PermissionRule`, `PermissionRequest`, and `PermissionDecision`.

LC-002: Add per-tool permission requirements. [x]
Define requirements for every current tool: `list_files`, `read_file`, `grep`, and `request_user_input` are `read-only`; `write_file` and `edit_file` are `workspace-write`; `bash` is `danger-full-access` unless EPIC-02 command classification lowers it.

LC-003: Extend chat call options. [x]
Add optional `permissionMode`, `allowedTools`, and `permissionRules` to validated chat request/call options. Default to current behavior with `build` using `workspace-write` plus approval for escalation, and `plan` using `read-only`.

LC-004: Enforce policy in runtime dispatch. [x]
Before `executeCodingTool` runs a tool, check the policy. Return a structured denied output when execution is blocked.

LC-005: Replace hardcoded risky-tool approval logic. [x]
Refactor `riskyCodingTools` handling so the UI displays approvals whenever policy returns `ask`, `approval-required`, or escalation.

LC-006: Persist denied/approved tool outputs consistently. [x]
Ensure assistant tool-call loops receive a valid tool output for allow, deny, and error states so streaming can continue cleanly.

LC-007: Add permission tests. [x]
Cover read-only blocks, workspace-write allows file edits, bash escalation asks, allowedTools filters, and plan mode mutation denial.

## Implementation Notes

- Added `packages/ai/src/permissions/` with policy decisions, rule matching, mode ranking, and permission-denied errors.
- Added per-tool permission requirements and chat/call option schemas in `packages/ai/src/agent-tools.ts`.
- Plan mode is hard-clamped to `read-only` even if a stronger `permissionMode` is sent by the client.
- Filtered agent active tools through the permission policy before the provider sees them.
- Enforced the same permission policy in `packages/ai/src/runtime-registry.ts` before executing filesystem or shell tools.
- Replaced UI hardcoded risky-tool checks with policy-driven `allow`, `ask`, and `deny` handling in `packages/ai/src/react/use-coding-session-chat.ts`.
- Updated the CLI approval card to show the policy reason for pending approvals.
- Added `packages/ai/src/permissions/permission-policy.test.ts`.

## Verification

- `bun test packages/ai/src/permissions/permission-policy.test.ts`
- `bun run tool-schema:check`
- `bun run typecheck`

## Acceptance Criteria

- Plan mode cannot run `write_file`, `edit_file`, or mutating `bash`.
- Build mode can edit files after approval when policy requires approval.
- `allowedTools` can hide tools from the active tool set.
- Denied tools produce structured UI output and do not execute.
- `bun run typecheck` and `bun run tool-schema:check` pass.

## Execute Next

After this epic, start EPIC-02 to make the filesystem and shell enforcement stronger.
