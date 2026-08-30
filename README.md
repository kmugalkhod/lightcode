# Lightcode

A personal AI coding agent with terminal and localhost browser interfaces.
Lightcode pairs an OpenTUI client and a React browser workspace with one local
Hono API server, persistent SQLite sessions, a
permission-gated tool suite (files, shell, git, web, MCP), and tiered context
optimization that keeps long sessions inside the model's context window
without ever losing history.

## Install

```bash
npm install -g @kmugalkhod/lightcode
lightcode              # terminal UI
lightcode web          # browser UI on 127.0.0.1
```

Works on macOS (Apple Silicon and Intel), Linux, and Windows. Bun ships with
the package, so there's nothing else to install — the first `lightcode` run
uses the bundled runtime automatically (and reuses a system Bun if you already
have one). The published package is scoped as `@kmugalkhod/lightcode`; the
command it installs is `lightcode`.

The two interfaces share the same local sessions, history, provider settings,
and agent engine. `lightcode web` opens a dedicated loopback-only server and
launches your browser. Opening a project uses the host folder chooser first:
the Windows or macOS system dialog, then Zenity or KDialog on Linux when
available in a graphical session. If the system chooser is unavailable or
cannot open—including Linux without Zenity or KDialog—Lightcode falls back to
an authenticated in-app browser rooted at Home, Desktop, Documents, Downloads,
and Projects. That bounded browser is also available as a secondary project
action. The local server—not the browser page—receives and
canonicalizes the selected path, rejects filesystem, drive, and UNC share
roots, and grants only the chosen project; cancelling leaves the current
workspace unchanged. The per-launch browser credential stays in the URL
fragment and current tab and is never passed to agent subprocesses.

The browser rail stays focused on projects and sessions. Agents, Skills, MCP,
Plugins, and deeper customization remain managed through the terminal
interface for now.

The first browser release runs one Lightcode interface at a time: press Ctrl+C
to stop the TUI or browser server before switching. Sessions remain available
when you reopen them in the other interface. Use `lightcode web --no-open` on
headless systems; set `LIGHTCODE_WEB_PORT` to choose its starting port.

## Quick start (from source)

```bash
bun install
bun run cli:dev        # starts the TUI; it boots the server automatically
bun run web:build && bun apps/cli/src/index.tsx web  # browser UI from source
```

Lightcode is aware of the directory you launch it in: each turn it reads the
project's shape (top-level files and git branch/status), uses root `AGENTS.md`
instructions with `CLAUDE.md` as a fallback, and loads nested instructions only
when related paths are accessed. `README.md` remains ordinary project context,
not privileged instructions.

On first run Lightcode walks you through provider setup (Anthropic,
OpenRouter, OpenCode Zen, or any OpenAI-compatible endpoint) and stores the
API key in `~/.lightcode/credentials.json`. Environment variables such as
`ANTHROPIC_API_KEY` always take precedence.

## Commands

```bash
bun run cli:dev          # TUI (auto-starts the server)
bun run web:dev          # asset-only browser dev server (no agent API proxy)
bun run web:build        # build the browser assets
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
| `webSearch.backend` | `auto`, `provider`, `brave`, `tavily`, or `disabled` |
| `webSearch.maxResults`, `webSearch.maxUsesPerTurn` | Bound search results and per-turn search usage |
| `maxRetries` | Provider-call retries for transient errors (default 5) |
| `autoContinue.stallTimeoutSeconds` | Abort+retry a byte-silent stream (default 300; raise for very slow reasoning models) |
| `autoContinue.maxErrorRetries` | Auto-resends before surfacing a stream error (default 8) |
| `LIGHTCODE_DESKTOP_PATH`, `LIGHTCODE_DOCUMENTS_PATH`, `LIGHTCODE_DOWNLOADS_PATH`, `LIGHTCODE_PROJECTS_PATH` | Optional absolute overrides for the secure common-location fallback; they do not change the host-native picker |

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

## Skills

Skills are reusable instruction files the agent can load on demand — a recipe
for a recurring task (writing a PR description, cutting a release, following a
review checklist). Each skill is a `SKILL.md` file with frontmatter:

```markdown
---
name: pr-description
description: Write a clear PR title and description from the diff.
---

# Instructions the agent follows when this skill is loaded…
```

Lightcode discovers skills from three locations, first match wins (project
overrides user):

1. `.lightcode/skills/<name>/SKILL.md` — project-local
2. `.agents/skills/<name>/SKILL.md` — project-local (fallback)
3. `~/.lightcode/skills/<name>/SKILL.md` — available in every project

Each turn the agent is told which skills are available (name + description), so
just ask it to "use the pr-description skill" (or mention the skill by name) and
it loads the instructions via the `skill` tool and follows them. Run `/skills`
in the TUI to list what's installed. Only simple `key: value` frontmatter lines
are parsed (`name`, `description`); the rest of the file is the instruction body.

## Workspaces

- `apps/cli` — OpenTUI React terminal interface
- `apps/web` — React localhost browser interface
- `apps/server` — Hono API server (sessions, streaming, diagnostics)
- `packages/ai` — agent core: tools, permissions, context engine, config
- `packages/db` — Prisma + local SQLite storage
- `packages/shared` — logging, errors, version
