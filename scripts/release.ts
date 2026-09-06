/**
 * Release pipeline: verify → build → pack/publish → tag.
 *
 *   bun scripts/release.ts           # dry run: verify, build, npm pack
 *   bun scripts/release.ts --publish # additionally npm publish + git tag
 *
 * Bump the version in packages/shared/src/version.ts before releasing.
 */
import path from "node:path";
import { lightcodeVersion } from "../packages/shared/src/version";

const repoRoot = path.resolve(import.meta.dir, "..");
const publish = Bun.argv.includes("--publish");

function run(command: string[], cwd = repoRoot) {
  console.log(`$ ${command.join(" ")}`);
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    console.error(`Command failed: ${command.join(" ")}`);
    process.exit(result.exitCode ?? 1);
  }
}

console.log(`Releasing lightcode v${lightcodeVersion} (${publish ? "publish" : "dry run"})`);

run(["bun", "audit"]);
run(["bun", "run", "typecheck"]);
run(["bun", "test"]);
run(["bun", "scripts/build-dist.ts"]);

if (publish) {
  run(["npm", "publish", "--access", "public"], path.join(repoRoot, "dist"));
  run(["git", "tag", `v${lightcodeVersion}`]);
  console.log(`Published lightcode v${lightcodeVersion}. Push the tag with: git push origin v${lightcodeVersion}`);
} else {
  run(["npm", "pack"], path.join(repoRoot, "dist"));
  console.log("Dry run complete. Inspect the generated tarball in dist/.");
}
