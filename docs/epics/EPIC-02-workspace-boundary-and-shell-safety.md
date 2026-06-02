# EPIC-02 Workspace Boundary and Shell Safety

## Outcome

File and shell tools are safe enough to trust as building blocks. Workspace boundaries are enforced with real path checks, and shell commands are classified before execution.

## Depends On

EPIC-01 Runtime Permission Policy.

## Current Code Areas

- `packages/ai/src/common/resolve-within-workspace.ts`
- `packages/ai/src/bash/runtime.ts`
- `packages/ai/src/bash/schema.ts`
- `packages/ai/src/read-file/runtime.ts`
- `packages/ai/src/write-file/runtime.ts`
- `packages/ai/src/edit-file/runtime.ts`
- `packages/ai/src/list-files/runtime.ts`
- `packages/ai/src/grep/runtime.ts`

## Tickets

LC-008: Harden workspace path resolution. [x]
Resolve real paths for existing targets and nearest existing parents for new writes. Block symlink escape and case-insensitive Windows escape.

LC-009: Add workspace context object. [x]
Replace global-only `WORKSPACE` usage with a validated workspace context that can be passed from chat/session state.

LC-010: Add bash command classification. [x]
Classify commands into `read-only`, `workspace-write`, or `danger-full-access`. Start conservative: read commands such as `ls`, `cat`, `rg`, `git status`, `git diff`, and `bun run typecheck` can be lower risk; redirects, deletes, package installs, process control, network commands, and unknown commands escalate.

LC-011: Add shell approval details. [x]
Approval cards should show command, classification, cwd, timeout, and why approval is required.

LC-012: Add timeout and output policy tests. [x]
Cover timeout, truncated output, command failure output, and denial-before-exec.

LC-013: Add optional sandbox config placeholder. [x]
Add typed config fields for future sandbox behavior even if the first implementation only reports unsupported on Windows.

## Implementation Notes

- Hardened `resolveWithinWorkspace` so existing paths use realpath checks and new writes validate the nearest existing parent.
- Added `WorkspaceContext` and passed session `cwd` into runtime tool execution instead of relying only on the module-level default workspace.
- Added conservative bash command classification in `packages/ai/src/bash/command-classification.ts`.
- Wired bash classification into permission evaluation so `bash` can resolve to `read-only`, `workspace-write`, or `danger-full-access` per command.
- Updated shell approval details to include classification, cwd, timeout, and policy reason.
- Added sandbox config placeholders in `packages/ai/src/sandbox/config.ts`; enabled sandbox requests report unsupported on Windows.
- Added tests for command classification, workspace boundary/symlink handling, bash timeout/truncation/failure, and denial-before-exec.

## Verification

- `bun test packages/ai/src/bash/command-classification.test.ts`
- `bun test packages/ai/src/common/resolve-within-workspace.test.ts`
- `bun test packages/ai/src/bash/bash-runtime.test.ts`
- `bun test packages/ai/src/permissions/permission-policy.test.ts`
- `bun run typecheck`

## Acceptance Criteria

- Symlinks cannot read or write outside the workspace.
- New file writes cannot create files outside the workspace through parent traversal.
- Shell commands are denied or escalated by policy before execution.
- Approval UI gives enough context to make a decision.
- `bun run typecheck` passes.

## Execute Next

After this epic, start EPIC-03 so safe execution can be tied to durable session state.
