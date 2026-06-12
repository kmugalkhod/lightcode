# Lightcode

A personal AI coding agent with a terminal UI. Lightcode pairs an OpenTUI
chat interface with a local Hono API server, persistent SQLite sessions, a
permission-gated tool suite (files, shell, git, web, MCP), and tiered context
optimization that keeps long sessions inside the model's context window
without ever losing history.

## Quick start (from source)

```bash
bun install
bun run cli:dev        # starts the TUI; it boots the server automatically
```

On first run Lightcode walks you through provider setup (Anthropic,
OpenRouter, OpenCode Zen, or any OpenAI-compatible endpoint) and stores the
API key in `~/.lightcode/credentials.json`. Environment variables such as
`ANTHROPIC_API_KEY` always take precedence.

## Commands

```bash
bun run cli:dev          # TUI (auto-starts the server)
bun run server:dev       # API server alone, watch mode
bun run typecheck        # TypeScript + tool schema preflight
bun test                 # test suite
bun run build            # build the publishable package into dist/
bun run release          # verify + build + npm pack (--publish to release)
```

## Configuration

Settings merge from `~/.lightcode/settings.json`, then
`.lightcode/settings.json` in the project, then `LIGHTCODE_*` environment
variables. Notable keys:

| Key | Purpose |
| --- | --- |
| `provider`, `model`, `baseUrl` | Provider selection and model id |
| `defaultMode` | `build` or `plan` |
| `permissionMode`, `permissions` | Tool permission policy |
| `context.compactAtFraction` | Context compaction threshold (default 0.8) |
| `context.pruneAtFraction` | Tool-output pruning threshold (default 0.6) |
| `context.contextWindowOverride` | Override the model context window |
| `maxRetries` | Provider-call retries for transient errors (default 5) |
| `autoContinue.stallTimeoutSeconds` | Abort+retry a byte-silent stream (default 180) |

The local companion server listens on `127.0.0.1:4983` (uncommon on purpose —
port 3000 belongs to the apps you build). Override with `PORT` for the server
and `LIGHTCODE_API_URL` for the CLI. Runtime model switching: `/model` in the
TUI lists every OpenRouter model and persists the choice to
`~/.lightcode/settings.json`. Diagnostics: `GET /diagnostics/connectivity`
probes the provider endpoint, and daily JSONL logs live under the Lightcode
data directory (`logs/`).

## Context optimization

Long sessions stay healthy through three tiers: real-usage-calibrated token
estimation, free pruning of stale tool outputs and duplicate file reads, and
LLM-written summaries once the compaction threshold is crossed (with an
extractive fallback when the model is unreachable). The full conversation is
always preserved in SQLite — compaction only changes what the model sees.
Use `/compact` in a chat to compact manually.

## Workspaces

- `apps/cli` — OpenTUI React terminal interface
- `apps/server` — Hono API server (sessions, streaming, diagnostics)
- `packages/ai` — agent core: tools, permissions, context engine, config
- `packages/db` — Prisma + local SQLite storage
- `packages/shared` — logging, errors, version
