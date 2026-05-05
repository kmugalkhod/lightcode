# Lightcode

Bun workspace monorepo with runnable apps for a lightweight Hono server and OpenTUI CLI.

## Commands

```bash
bun install
bun run server:dev
bun run cli:dev
```

## Workspaces

- `apps/server`: Hono server running on Bun.
- `apps/cli`: OpenTUI welcome screen running on Bun.
- `packages/shared`: reusable internal code imported by both apps.
