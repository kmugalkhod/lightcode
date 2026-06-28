# `apps/server` — HTTP API & Agent Backend Explainer

This document explains how the Lightcode backend (`apps/server`) is built. It is a
reading guide for the source — not an end-user manual. For usage see the top-level
`README.md`.

## 1. Role and tech stack

`apps/server` is the local HTTP companion for the CLI TUI (`apps/cli`). It:
* Persists chat sessions (SQLite + Prisma).
* Streams AI coding agent turns (via Vercel AI SDK + `@lightcode/ai`).
* Implements REST + SSE routes for sessions, messages, checkpoints (tool approvals), config, diagnostics, and extension runtime.
* Is intentionally **local-only** (loopback by default) and unauthenticated.

Key dependencies (see `apps/server/package.json`):

| Dependency                 | Role |
|----------------------------|------|
| `hono` + `@hono/zod-validator` | Lightweight router + zod request validation |
| `ai` + `@ai-sdk/*`         | Streaming text + tool-calling primitives |
| `@lightcode/ai`            | Coding agent, tool registry, permissions, context building, MCP/skills |
| `@lightcode/db`            | Prisma client, local SQLite setup (libsql adapter) |
| `@lightcode/shared`        | Logging, shared constants |
| `zod`                      | Schemas shared with the CLI via `@lightcode/ai` |

The package is private to the monorepo and is not published. The CLI imports its type (`AppType`) via the workspace export for RPC client typing (`hono/client`).

## 2. Startup and lifecycle (`src/index.ts`)

Entry point when run directly (`bun src/index.ts` or via scripts):
1. Enable optional file logging via shared sink.
2. Resolve port (`PORT` or 4983; the latter avoids collisions with dev scaffolds) and hostname (`LIGHTCODE_HOST` or `127.0.0.1`).
3. Import the composed Hono `app`. Failure to load prints advice about settings/credentials.
4. Best-effort async init:
   - `initializeModelCapabilities()` (enriches OpenRouter model metadata).
   - `ensureHeadroomRouting()` (probes headroom-compression proxy if enabled).
5. Start `Bun.serve`:
   - Chat streams (`POST /sessions/:id/chat`) receive **idle timeout disabled** at the Bun level; the app itself controls lifetime.
6. Graceful shutdown:
   - On SIGINT/SIGTERM: stop server, disconnect Prisma, exit.
   - A fire-and-forget force-exit timer protects against stuck streams.
7. **Parent-death watchdog**: If `LIGHTCODE_PARENT_PID` is set (the CLI that spawned us), poll parent existence; exit if parent dies. Prevents orphaned server processes on macOS.
8. Console prints `Server listening on http://${hostname}:${port}`.

Exports:
* `export type AppType = typeof appInstance;` — consumed by the CLI for type-safe `hc<AppType>(...)`.

## 3. Composed Hono app (`src/app.ts`)

A single `Hono` instance wires:
* Global body limit (32 MiB) with a JSON error.
* Route mounts:
  * `/` → `rootRoutes`
  * `/config` → `configRoutes`
  * `/diagnostics` → `diagnosticsRoutes`
  * `/extensions` → `extensionRoutes`
  * `/sessions` → `sessionRoutes` (main chat surface)

`rootRoutes` only provides the root greeting (`{ name, message }`).

## 4. Route surface

### Config (`/config`)
`GET /config/status` — runtime, resolved provider/model, loaded files, permission defaults.
`POST /config/reload` — hot-reloads config without restart.
`GET /config/models?provider=openrouter[&refresh=1]` — OpenRouter catalog (cached).
`PUT /config/model` — switches provider/model + optional live capability probe. Persists to settings by default.

### Diagnostics (`/diagnostics`)
`GET /diagnostics/status` — provider, database counts, config snapshot, tool summary counts, features flags, extensions snapshot.
`GET /diagnostics/doctor` — human readable checks (server, db, provider, workspace, sandbox, tools, extensions).
`GET /diagnostics/permissions` — categorized tool list + permission mode mapping.
`GET /diagnostics/tools` — full per-tool details + provider schema status.
`GET /diagnostics/sandbox` — current sandbox runtime flags.

### Extensions (`/extensions`)
`GET /extensions/skills` / `GET /extensions/skills/:name` — registered skills discovery/load.
`GET /extensions/plugins` — discovered plugins + hook counts.
`GET/POST /extensions/mcp/servers[/...]` — list, inspect, start, stop MCP servers declared in config.

### Sessions (`/sessions`) — the main API
**Listing & lifecycle**
* `GET /sessions` — list sessions (summary).
* `POST /sessions` — create (with cwd, optional mode/title/permissionMode). Uses current `chatModelId`.
* `GET /sessions/:id` — resume (metadata + last messages + compact `contextState`).
* `GET /sessions/:id/messages` — messages only (plus contextState).
* `GET /sessions/:id/context` — raw provider view for the session.
* `PATCH /sessions/:id` — rename +/or change permission mode.
* `DELETE /sessions/:id` — remove session and cascade.
* `POST /sessions/:id/fork` — branch a new session from current history.
* `GET /sessions/:id/export` — full JSON export (messages + context + interactions).

**Chat streaming**
* `POST /sessions/:id/chat` — **streams** a turn. Accepts `{ messages, cwd, mode?, permissionMode?, allowedTools?, permissionRules?, sandbox? }`.
  * Body is a full `UIMessage[]` array from AI SDK.
  * Response is SSE using `createAgentUIStreamResponse`.
  * On finish messages are persisted; a background auto-title may run.
  * Large history is tiered and compacted before sending to provider.

**Interactions (checkpoints / approvals)**
Interactions allow the agent to pause and ask for approval before dangerous actions, or surface a user_prompt request. Stored in a small companion SQLite (Bun native) beside the Prisma DB.
* `GET /sessions/:id/interactions?status=&kind=`
* `POST /sessions/:id/interactions` — create/upsert a pending interaction.
* `PATCH /sessions/:id/interactions/:toolCallId` — resolve with a status + optional response payload.

**Compaction trigger**
* `POST /sessions/:id/compact` — forces on-demand context compaction (tier-2 summary) regardless of automatic heuristics.

## 5. Persistence model

Two stores coexist:

1. **Primary store (`@lightcode/db` via Prisma + libsql/SQLite)**
   * `ChatSession` — id, title, cwd, mode, permissionMode, model, revision, autoTitled flag.
   * `ChatMessage` — sequenced JSON payload of `UIMessage`, role, model used.
   * `SessionContextState` — one row per session: compact `summary`, `anchorMessageId`, `coveredMessageCount`, `estimatedTokens`, `tier`.
   * `SubagentTask` — background subagent execution records.
   * Cascade delete on session removal.

2. **Chat interaction store (`src/lib/chat-interaction-store.ts`)**
   * Raw Bun:SQLite file (same path as the Prisma DB file) holding `ChatInteraction` rows for tool approvals and user prompt requests.
   * Separate small schema because interactions are high-frequency, low-complexity, and need fast keyed updates.
   * Opened once, closed on process exit.

The CLI never talks directly to SQLite; everything goes through the server's routes.

## 6. The chat flow (`chat-stream.ts` + supporting modules)

1. Client sends messages + effective config overrides.
2. Server resolves the session, loads recent messages + any prior compact context state.
3. Builds the *provider view* via `buildProviderView` (from `@lightcode/ai`):
   * Injects a compact "Previously..." summary as a system message (tier-1 or tier-2).
   * Trims the tail to a model-specific budget via `fitMessagesToBudget`.
   * Adds project/workspace context, TODOs, pinned plans, running subagents.
4. Constructs an agent from `@lightcode/ai` (`createCodingAgent`):
   * Wired to the current language model (possibly through XML middleware).
   * Tools selected by mode + intent; filtered by permission engine.
   * System prompt assembled from mode + discipline instructions if needed.
5. Streams via AI SDK:
   * `streamText` + `createAgentUIStreamResponse` emits text, tool calls, tool results, reasoning, usage metadata.
   * Heartbeat wrapper keeps the SSE connection alive.
   * AbortSignal is wired to the original Request so the client can cancel.
6. On finish:
   * Persist new assistant message(s) and tool events.
   * Run deterministic merge heuristics to collapse partial streaming states.
   * Schedule best-effort auto-title (first user+assistant pair → short title) if not yet titled and not manually renamed.
   * Update `SessionContextState` if compaction happened inside this turn.
   * If overflow occurred, record learned context limits and overflow marks used by the next turn's heuristics.
7. Errors are classified (`classifyChatError`) for clean UX:
   * Billing / quota → 402.
   * Network / disconnect → 503 recoverable message.
   * Context overflow → triggers overflow recovery path on next turn.
8. Observability (per-turn structured logs + counters):
   * `chat-observability.ts`: tags for phase (pre-stream, stream, write), disconnects, failure classes.
   * Counters used by diagnostics.

### Context compaction & tiering

* `context-compaction.ts` produces dense factual summaries when a session approaches its model's context window or crosses configured headroom limits.
* `context-state-store.ts` persists the summary + `anchorMessageId` + covered range.
* `buildProviderView` folds prior summaries and progressively trims older history.
* Automatic triggers happen inside stream creation; manual compaction available via `POST /:id/compact`.

Additional facilities:
* `overflow-recovery.ts` — preserves recent turns after an overflow.
* `learned-context-limit.ts` — learns a conservative per-model cap from observed failures.
* `workspace-context.ts` — injects top-level file tree, git state, AGENTS.md contents.

## 7. Runtime configuration and model switching (`runtime-config.ts` + `provider-registry.ts`)

* Config is loaded once at import from `loadLightcodeConfig` (files: `~/.lightcode/settings.json`, project `.lightcode/settings.json`, etc.).
* Live exports (`lightcodeConfigResult`, `resolvedProviderModel`, `codingAgent`, `chatModelId`) are `let` so they can be swapped without restart.
* `applyModelSelection` validates the new model (optionally fetches OpenRouter capabilities), builds a fresh agent, and atomically rebinds the module exports.
* Provider resolution supports:
  * `anthropic`
  * OpenAI-compatible with arbitrary `baseURL`
  * `openrouter`, `opencodezen` (aliases that pick defaults + may inject XML middleware)
* Credential hints come from `readStoredCredentials` and env. Missing keys surface in diagnostics and status.

"Headroom proxy" (when enabled) routes traffic through a local compression proxy; the registry reports both the real upstream URL and the effective (proxied) URL separately.

## 8. Diagnostics and troubleshooting

`/diagnostics/doctor` runs a checklist returning structured rows. Useful for:
* Verifying DB reachability + row counts.
* Seeing whether the current provider/model has valid credentials.
* Inspecting which tools are active in which modes and their permission tiers.
* Confirming MCP / plugin counts.

`/diagnostics/status` is a machine friendly snapshot used by the CLI.

## 9. Extensions, skills, MCP, plugins

`@lightcode/ai` exports the loaders; the server exposes thin HTTP wrappers:
* Skills are discovered relative to the user's `cwd` (invocation directory) using a lockfile + manifest convention.
* MCP servers declared in config can be started/stopped on demand; the `McpServerManager` maintains lifecycle.
* Plugins hook into the agent or I/O; the server only reports counts + enabled state.
* `/extensions` endpoints are used by the CLI to populate slash commands / picker UI.

## 10. Security and isolation notes

* The server binds to loopback (configurable but not recommended for arbitrary networks).
* No authentication layer — the threat model assumes local machine only.
* Permission engine (in `@lightcode/ai`) gates what tools may run and whether they need explicit approval.
* Sandbox (when configured) restricts subprocesses and filesystem writes.
* Body size capped; dangerous operations require user approval via the interaction checkpoint flow.
* Parent PID watchdog + graceful shutdown prevent leaking processes that could hold stale config state.

## 11. How the CLI uses the server

* `apps/cli/src/lib/client.ts` creates a typed client:
  ```ts
  import type { AppType } from "@lightcode/server/rpc";
  export const client = hc<AppType>(apiBaseUrl);
  ```
* `ensureServerRunning()` (and `restartOwnedServer()`) from `server-launcher.ts` start or recover the companion. The launcher passes `LIGHTCODE_PARENT_PID`.
* The CLI drives the entire UX via the typed HTTP surface; there is no direct in-process agent execution in the TUI.

## 12. Development & testing

Scripts (from `apps/server/package.json`):
* `bun run dev` — watch mode with root `.env` loaded.
* `bun run start` — normal start.
* `bun run typecheck` — project-scoped TypeScript.

Isolated test files live next to modules (`.test.ts`). Key testable flows:
* `chat-stream`, `chat-store`, `chat-interaction-store`
* `context-compaction`, `overflow-recovery`, `learned-context-limit`
* `provider-registry`, `session-auto-title`, `workspace-context`

Run from repo root for full workspace type/linking:
* `bun run --cwd apps/server typecheck`
* `bun run typecheck` (repo-wide)

## 13. File map (key modules)

```
apps/server/src/
├── index.ts                 # Bun.serve entry + lifecycle
├── app.ts                   # Hono composition
├── routes/
│   ├── root-routes.ts
│   ├── config-routes.ts
│   ├── diagnostics-routes.ts
│   ├── extension-routes.ts
│   ├── chat-routes.ts       # sessions, chat, interactions, compaction
│   └── route-helpers.ts
└── lib/
    ├── runtime-config.ts
    ├── provider-registry.ts, openrouter-models.ts
    ├── chat-store.ts, chat-stream.ts
    ├── chat-interaction-store.ts
    ├── context-compaction.ts, context-state-store.ts
    ├── chat-observability.ts, chat-history-merge.ts
    ├── sse-heartbeat.ts, overflow-recovery.ts, learned-context-limit.ts
    ├── session-auto-title.ts, workspace-context.ts
    ├── headroom-proxy.ts, extension-runtime.ts
    └── prisma-client.ts      # re-exports @lightcode/db/server
```

## 14. Relationship diagram (simplified)

```
         +-------------------+
         |  apps/cli (TUI)   |
         |  + useChat hook   |
         |  | hc<AppType>    |
         +---------+---------+
                   | HTTP + SSE (127.0.0.1)
                   v
         +-----------------------------+
         | apps/server (Hono + Bun)    |
         |  routes → lib/*             |
         |     |                       |
         |     v                       |
         |  @lightcode/ai (agent)      |
         |     |    tools, MCP, skills |
         |     v                       |
         |  @lightcode/db (Prisma)     |
         |     + SQLite file           |
         +-----------------------------+
                   ^ external providers
                   | (Anthropic, OpenRouter…)
```

Happy exploring! If you edit any of the modules above, keep this document in sync so future readers can understand the whole picture without re-deriving the architecture.