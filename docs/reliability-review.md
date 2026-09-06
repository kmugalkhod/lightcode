# Lightcode reliability review — 2026-09-06

This change hardens the existing local coding harness. It is not a certification
of every model, operating system, or enterprise network. The review combined
targeted source inspection of networking, provider routing, skills, streaming,
web fetching and packaging with the repository-wide tests, typecheck, build,
and dependency audit.

## Findings addressed

- The Windows npm launcher only imported LocalMachine certificates, missing
  company roots installed for CurrentUser. It reused predictable temporary
  paths, could retain stale certificates, and had no PowerShell timeout. It
  now exports both trusted Root stores into a unique directory, cleans up on
  exit, respects explicit CA settings, and limits export time to ten seconds.
- Provider, catalog, diagnostics and web-tool requests now share a CA-aware
  transport. Explicit PEM bundles extend public roots without disabling TLS
  verification. Nested SDK certificate errors produce actionable, nonretryable
  chat errors. Local CLI/server traffic bypasses global HTTP proxies.
- OpenAI-compatible local servers were rejected before chat when they had no
  API key. Custom endpoints can now run unauthenticated; hosted providers still
  check for their required credentials.
- Skill discovery missed common global installations and a broken symlink
  could hide the entire catalog. It now checks Lightcode, shared agent, Claude,
  Codex and OpenCode locations, handles symlinks/cycles, parses YAML metadata,
  bounds directory walks, and supports additional configured roots.
- The prompt hid skills after the first 20 and the skill tool was selectively
  activated. All discovered names are surfaced with bounded descriptions and
  the tool is available for ordinary work. Supporting resources are readable
  within the skill's real directory; traversal and escaping symlinks fail.
- Provider fetch lost Request-owned abort signals, detached cancellation when
  the body timeout was disabled, and leaked cleanup work on some failures.
  Cancellation now releases the reader/connection and cleans up timers/listeners.
- Web fetch buffered entire responses before truncating, and invalid numeric
  HTML entities could discard a useful page. Downloads now stop at 2 MiB of
  decompressed data and invalid Unicode entities remain text.
- The lockfile contained vulnerable dependencies. Hono and React Router were
  updated, compatible dependency ranges refreshed, and security overrides
  added for pinned transitive dependencies. Both WebSocket major versions
  retain their existing major and use patched versions with registry integrity
  hashes. Release verification now includes `bun audit`.

## Dependency override rationale

The root overrides pin patched versions of Hono, its Node adapter, fast-uri,
mysql2, shell-quote and valibot. `deepmerge-ts` requires a major override to 8.0.2
because Prisma config pins version 7. Its
[security fix](https://github.com/advisories/GHSA-ggr8-5vv4-36mx) addresses cyclic
object recursion. Version 8 also changes Map merging; Prisma configuration
loading, schema validation, client generation and the database regression
tests are checked with this override. Remove overrides as upstream dependency
ranges catch up. These root overrides protect this repository installation;
they are not a promise that npm honors dependency-owned overrides in an
arbitrary downstream project.

## Verification and limits

Final verification on macOS with Bun 1.3.14: 711 tests passed across 110 files;
the full typecheck/schema preflight, distributable CLI/server/browser build,
Node launcher syntax check, and Prisma client generation/schema validation
passed. `bun audit` reported no vulnerabilities. These are local checks, not
results from a cross-platform CI or paid live-provider test matrix.

The checks include a real local HTTPS server demonstrating rejection without
trust, success with an explicit private CA, and rejection for a hostname
mismatch. An AI SDK tool-call round trip uses a mock OpenAI-compatible endpoint.
The Windows launcher is exercised with simulated Windows/process/filesystem
dependencies; it has not been run against a real Windows certificate store in
this session. Prisma validation/generation do not migrate user databases.

Connectivity to Anthropic, OpenRouter and OpenCode Zen succeeded from this
machine; the available Lightcode logs contained no certificate failure.
Consequently the exact office failure was not reproduced. A CurrentUser-only
company root is one concrete failure case the old Windows launcher missed.
Company roots unknown to the runtime still require an IT-provided PEM bundle,
as described in [OpenCode's network documentation](https://opencode.ai/docs/network/)
and the Lightcode README. External MCP programs and shell subprocesses retain
their own runtime's trust settings.

Automatic skill discovery covers the documented roots, not a full-disk search
or automatic activation of every plugin cache. Other installations can be
added through `LIGHTCODE_SKILL_PATHS`. Model protocol support and tool-use
quality still matter; no test here establishes compatibility with every model.
Native Windows/Linux release smoke tests and verification on the actual office
network remain necessary before claiming cross-platform production readiness.
