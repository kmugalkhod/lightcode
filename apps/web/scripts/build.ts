import { copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(import.meta.dir, "..");
const outputDirectory = path.join(webRoot, "dist");

// Hashed asset names change between builds. Always remove this exact generated
// directory first so stale JavaScript and CSS cannot leak into the npm tarball.
rmSync(outputDirectory, { recursive: true, force: true });

const result = Bun.spawnSync(
  [
    "bun",
    "build",
    "index.html",
    "--outdir",
    "dist",
    "--target",
    "browser",
    "--production",
    "--minify",
    "--external",
    "/app/geist-latin.woff2",
  ],
  {
    cwd: webRoot,
    stdout: "inherit",
    stderr: "inherit",
  },
);

if (result.exitCode !== 0) {
  process.exit(result.exitCode);
}
copyFileSync(
  fileURLToPath(import.meta.resolve("@fontsource-variable/geist/files/geist-latin-wght-normal.woff2")),
  path.join(outputDirectory, "geist-latin.woff2"),
);
copyFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.resolve("@fontsource-variable/geist/package.json"))), "LICENSE"),
  path.join(outputDirectory, "geist-LICENSE.txt"),
);
