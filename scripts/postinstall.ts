/**
 * Post-install hook: generate the Prisma client into packages/db/generated/prisma
 * so `bun run cli:dev` / `bun run server:dev` / the test suite work straight
 * after a `bun install` in this repo.
 *
 * This is intentionally BEST-EFFORT. The published package (dist/) bundles the
 * generated client and ships no postinstall, so a missing client here never
 * affects end users. When Lightcode is pulled in from source/git (e.g. an
 * `npm install <git-url>` "prepare" step), the `prisma` devDependency — and
 * therefore the `prisma/config` import inside prisma.config.ts — may not be
 * resolvable. In that case we skip with a note instead of aborting the install.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Resolve from the db package, matching how prisma.config.ts imports "prisma/config".
const dbDir = resolve(import.meta.dir, "..", "packages", "db");

function prismaConfigResolvable(): boolean {
  try {
    Bun.resolveSync("prisma/config", dbDir);
    return true;
  } catch {
    return false;
  }
}

if (!prismaConfigResolvable()) {
  console.log(
    "[lightcode] Skipping `prisma generate` — the `prisma` dev dependency isn't " +
      "installed here. This is expected for consumer/git installs (the published " +
      "package ships the generated client). For local dev, run `bun install` in the repo.",
  );
  process.exit(0);
}

const result = spawnSync(
  "bunx",
  ["--bun", "prisma", "generate", "--config", "packages/db/prisma.config.ts"],
  { stdio: "inherit" },
);

if (result.status !== 0) {
  // The client is a regenerable dev artifact (`bun run db:generate`); never fail
  // the install over it.
  console.log(
    "[lightcode] `prisma generate` did not complete; continuing without failing " +
      "the install. Run `bun run db:generate` manually if you need the client locally.",
  );
}

process.exit(0);
