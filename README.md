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

## Office networks and certificates

Lightcode uses the same standard enterprise configuration described in
[OpenCode's network documentation](https://opencode.ai/docs/network/):
`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, and `NODE_EXTRA_CA_CERTS`.
Local CLI/server connections bypass the proxy automatically.
The npm launcher on Windows also imports trusted roots from both LocalMachine
and CurrentUser stores when no explicit CA file is configured. Its export is
isolated per launch and limited to ten seconds.

If your office inspects HTTPS traffic, use the company CA bundle supplied by
your IT team (PEM format):

```bash
export NODE_EXTRA_CA_CERTS=/absolute/path/company-ca.pem
lightcode
```

`LIGHTCODE_CA_CERTS` and `SSL_CERT_FILE` are also supported for Lightcode's
provider, model catalog, connectivity probe, and web-tool requests. Explicit
bundles extend the public trust roots using
[Bun's TLS fetch options](https://bun.sh/docs/runtime/networking/fetch).
Certificate verification remains enabled. Untrusted, expired, and mismatched
certificates report an actionable error instead of triggering repeated chat
retries. Restart Lightcode after changing network configuration. Subprocesses
and external MCP programs use their own runtime's certificate settings; use
`NODE_EXTRA_CA_CERTS` when those runtimes support it.

OpenAI-compatible endpoints can run without an API key, including local model
servers. Supply their `/v1` base URL and exact model ID. Model compatibility
still depends on the endpoint implementing the supported API and the model
being capable of tool use; an arbitrary model name alone cannot guarantee that.

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

Lightcode discovers installed skills automatically, first match wins (project
overrides user), in this order:

1. `.lightcode/skills/<name>/SKILL.md` — project-local
2. `.agents/skills/<name>/SKILL.md` — project-local (fallback)
3. Project `.claude/skills`, `.codex/skills`, and `.opencode/skills`
4. User `~/.lightcode/skills`, `~/.agents/skills`, and `~/.claude/skills`
5. `$CODEX_HOME/skills` (defaults to `~/.codex/skills`, including `.system`)
6. `$XDG_CONFIG_HOME/opencode/skills` (defaults to `~/.config/opencode/skills`)
7. Additional roots in `LIGHTCODE_SKILL_PATHS` (colon-separated on Unix,
   semicolon-separated on Windows). Use this for other installations or
   plugin skill directories you want to make available.

Each turn the agent is told which skills are available (name + description), so
just ask it to "use the pr-description skill" (or mention the skill by name) and
it loads the instructions via the `skill` tool and follows them. Run `/skills`
in the TUI to list what's installed. The agent can select relevant skills for
ordinary tasks without you naming one. YAML frontmatter supports quoted and
multiline `name`/`description` fields. Supporting files can be loaded through
the `skill` tool's `resource` argument, relative to the skill directory.
Discovery follows installation symlinks, skips broken/unreadable/malformed
entries, and refreshes within 30 seconds. Scans are bounded to eight directory
levels and 2,000 directories per root; individual files are limited to 1 MiB.
Discovery does not execute skill scripts or override tool permissions.

## Workspaces

- `apps/cli` — OpenTUI React terminal interface
- `apps/web` — React localhost browser interface
- `apps/server` — Hono API server (sessions, streaming, diagnostics)
- `packages/ai` — agent core: tools, permissions, context engine, config
- `packages/db` — Prisma + local SQLite storage
- `packages/shared` — logging, errors, version
