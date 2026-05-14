# AGENTS.md

## Repo Shape

- Bun monorepo using `packageManager: bun@1.3.13`; root is private and workspaces are `apps/*` plus reserved `packages/*`.
- `apps/cli` is the OpenTUI React CLI app; entrypoint is `apps/cli/src/index.tsx` and the `lightcode` bin currently points to that TSX source with a Bun shebang.
- `apps/server` is the Hono API app; entrypoint is `apps/server/src/index.ts`, exports `app`, and only starts `Bun.serve` under `import.meta.main`.
- `packages/shared` is the reusable internal package; import it as `@lightcode/shared` from apps instead of reaching across directories.

## Source Layout

- Use kebab-case for source filenames, including TSX component files; avoid PascalCase filenames.
- In `apps/cli/src`, keep screen-level containers under `screens/` and reusable UI pieces under `components/`; do not leave components directly in the source root.
- Keep `apps/cli/src/index.tsx` as the CLI entrypoint and import screens/components from their dedicated folders.

## Commands

- Install dependencies with `bun install`; `bunfig.toml` sets `[install] linker = "hoisted"`.
- Run the CLI from the root with `bun run cli:dev` or `bun run cli:start`.
- Run the server from the root with `bun run server:dev` for watch mode or `bun run server:start` for normal start.
- Typecheck everything with `bun run typecheck`; package-scoped typechecks are `bun run --cwd apps/cli typecheck` and `bun run --cwd apps/server typecheck`.
- There are no test, lint, formatter, build, or packaging scripts defined yet; do not assume they exist.

## Tooling Notes

- TypeScript config is rooted at `tsconfig.base.json`; app/package configs extend it via `../../tsconfig.base.json` and `@lightcode/shared` is mapped to `packages/shared/src/index.ts`.
- The CLI TS config adds `DOM`, `jsx: react-jsx`, and `jsxImportSource: @opentui/react`; keep JSX/OpenTUI files under `apps/cli/src` unless adding config coverage.
- The server reads `PORT` from `Bun.env.PORT` and defaults to `3000`.
- Prefer Hono's zod validator (`@hono/zod-validator`). Read validated typed input via `c.req.valid('json')`.
- Use Zod schemas for client-side parsing too, including route/location state and other untrusted or unknown payloads; parse at the consuming boundary instead of type-casting.
- `dist/`, `.env*`, logs, and all `node_modules/` directories are ignored; do not commit generated standalone CLI artifacts unless packaging support is explicitly added.
