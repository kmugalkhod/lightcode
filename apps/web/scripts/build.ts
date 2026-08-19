import { rmSync } from "node:fs";
import path from "node:path";

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
