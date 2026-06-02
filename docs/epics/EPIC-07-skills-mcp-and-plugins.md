# EPIC-07 Skills MCP and Plugins

## Outcome

Lightcode can load local skills, connect to MCP servers, and eventually install/enable plugins with lifecycle hooks.

## Depends On

EPIC-06 Diagnostics and Slash Commands.

## Current Code Areas

- `packages/ai/src/agent-tools.ts`
- `packages/ai/src/runtime-registry.ts`
- `apps/server/src/app.ts`
- `apps/cli/src/navigation/route-registry.ts`

## Tickets

LC-041: Add skills resolver. [x]
Search project and user skill directories for `SKILL.md`, parse basic frontmatter, and expose `skills list/show`.

LC-042: Add `skill` tool. [x]
Let the model load a skill by name and return instructions plus metadata.

LC-043: Add MCP config schema. [x]
Support local stdio MCP server definitions first. Keep remote HTTP/SSE MCP for a later ticket.

LC-044: Add MCP server lifecycle. [x]
Start, list, inspect, and stop configured MCP servers. Report degraded states.

LC-045: Add MCP tools/resources. [x]
Expose `list_mcp_resources`, `read_mcp_resource`, and dynamic MCP tool execution behind permission policy.

LC-046: Add plugin manifest schema. [x]
Support local plugin directories with metadata, tools, and hooks. Install/enable/disable can be file-system local only in the first version.

LC-047: Add hook runner. [x]
Support `PreToolUse`, `PostToolUse`, and `PostToolUseFailure`, with hook results able to allow, deny, or ask through EPIC-01 policy.

## Implementation Notes

- Added local skills discovery from `.lightcode/skills`, `.agents/skills`, and user `~/.lightcode/skills`.
- Added `skill` as a read-only model tool with provider-safe schema and runtime execution.
- Added MCP stdio config schema under Lightcode config as `mcp.servers`.
- Added an MCP lifecycle manager that can list, inspect, start, and stop configured stdio servers without auto-starting arbitrary commands.
- Added permission-gated MCP tools: `list_mcp_resources`, `read_mcp_resource`, and `call_mcp_tool`.
- Added `/extensions/skills`, `/extensions/skills/:name`, `/extensions/mcp/servers`, MCP start/stop/inspect routes, and `/extensions/plugins`.
- Added local plugin manifest parsing from `.lightcode/plugins/*/plugin.json` and user `~/.lightcode/plugins/*/plugin.json`.
- Added a hook runner for `PreToolUse`, `PostToolUse`, and `PostToolUseFailure`; hooks are disabled unless `LIGHTCODE_ENABLE_PLUGIN_HOOKS=true`, and hook `allow` cannot bypass EPIC-01 permission evaluation.
- Extended `/diagnostics/status` and `/diagnostics/doctor` with skill/MCP/plugin health.
- First MCP resource/tool implementation is lifecycle and permission-ready; protocol-level stdio JSON-RPC bridging remains the next hardening step before rich remote resource reads.

## Verification

- `bun test packages/ai/src/skills/skills-runtime.test.ts packages/ai/src/mcp/mcp-config.test.ts packages/ai/src/plugins/plugin-runtime.test.ts`
- `bun run tool-schema:check`
- `bun run typecheck`

## Acceptance Criteria

- Skills can be listed and loaded from project-local directories.
- MCP server health appears in `/doctor` and `/status`.
- MCP tools are permission-gated.
- Plugin hooks cannot bypass permission policy.
- `bun run typecheck` passes.

## Execute Next

After this epic, start EPIC-08 to build subagents on top of the now-extensible runtime.
