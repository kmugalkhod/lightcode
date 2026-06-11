/**
 * Builds the publishable npm package into dist/:
 *   dist/cli.js      — TUI entry (bin), boots the server as a child process
 *   dist/server.js   — Hono API server
 *   dist/package.json
 *
 * Workspace code (@lightcode/*) is bundled; real npm dependencies stay
 * external and are declared in the generated manifest so native modules
 * (OpenTUI zig libs, libsql) install normally on the target machine.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { lightcodeVersion } from "../packages/shared/src/version";

const repoRoot = path.resolve(import.meta.dir, "..");
const distDir = path.join(repoRoot, "dist");

const workspaceManifestPaths = [
  "apps/cli/package.json",
  "apps/server/package.json",
  "packages/ai/package.json",
  "packages/db/package.json",
  "packages/shared/package.json",
];

// Packages that use "latest" and need to be resolved from bun.lock
const packagesToResolve = ["@opentui/core", "@opentui/react", "hono"];

/**
 * Reads the bun.lock file and resolves "latest" version specifiers to actual versions.
 * Uses regex to extract versions since bun.lock uses non-standard JSON.
 */
function resolveLatestVersions(
  dependencies: Record<string, string>
): Record<string, string> {
  try {
    const lockPath = path.join(repoRoot, "bun.lock");
    if (!existsSync(lockPath)) {
      return dependencies;
    }

    const lockContent = readFileSync(lockPath, "utf8");
    for (const pkgName of packagesToResolve) {
      if (dependencies[pkgName] === "latest") {
        // Match the pattern "package@version" in the bun.lock
        // Line format: "hono": ["hono@4.12.25", "", {}, "sha512-..."]
        const escapedName = pkgName.replace("/", "\\/");
        // Simple pattern: find "package@version" anywhere in the file
        const regex = new RegExp(`"${escapedName}@([0-9][^"]*)"`, "g");
        const match = regex.exec(lockContent);

        if (match && match[1]) {
          dependencies[pkgName] = match[1];
        }
      }
    }
  } catch (error) {
    console.warn("Could not resolve latest versions from bun.lock:", error);
  }

  return dependencies;
}

function collectExternalDependencies(): Record<string, string> {
  const dependencies: Record<string, string> = {};

  for (const manifestPath of workspaceManifestPaths) {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, manifestPath), "utf8"),
    ) as { dependencies?: Record<string, string> };

    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (name.startsWith("@lightcode/")) {
        continue;
      }

      dependencies[name] = version;
    }
  }

  // Resolve "latest" to actual versions from bun.lock
  const resolved = resolveLatestVersions(dependencies);

  return Object.fromEntries(
    Object.entries(resolved).sort(([a], [b]) => a.localeCompare(b)),
  );
}

async function buildEntry({
  entry,
  outfile,
  externals,
}: {
  entry: string;
  outfile: string;
  externals: string[];
}) {
  const args = [
    "build",
    path.join(repoRoot, entry),
    "--target=bun",
    `--outfile=${path.join(distDir, outfile)}`,
    ...externals.flatMap((name) => ["--external", name]),
  ];

  const result = Bun.spawnSync(["bun", ...args], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    console.error(result.stderr.toString());
    throw new Error(`bun build failed for ${entry}`);
  }
}

const externalDependencies = collectExternalDependencies();
const externalNames = Object.keys(externalDependencies).flatMap((name) => [
  name,
  `${name}/*`,
]);

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

await buildEntry({
  entry: "apps/server/src/index.ts",
  outfile: "server.js",
  externals: externalNames,
});
await buildEntry({
  entry: "apps/cli/src/index.tsx",
  outfile: "cli.js",
  externals: externalNames,
});

// Bun keeps the entry shebang, but guarantee it for the bin script.
const cliPath = path.join(distDir, "cli.js");
const cliSource = readFileSync(cliPath, "utf8");
if (!cliSource.startsWith("#!")) {
  writeFileSync(cliPath, `#!/usr/bin/env bun\n${cliSource}`, "utf8");
}

// Create a Node-compatible launcher that checks for Bun and fails fast with a clear message.
const launcherSource = `#!/usr/bin/env node
/**
 * Lightcode launcher - ensures Bun is installed before running the actual CLI.
 */

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// Check if Bun is available
try {
  const result = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("Bun not found");
  }
  const version = result.stdout.trim();
  const [major, minor] = version.split(".").map(Number);
  // Accept Bun >= 1.3.0
  if (major < 1 || (major === 1 && minor < 3)) {
    console.error("Lightcode requires Bun >= 1.3.0. Found: " + version);
    console.error("Install the latest Bun from https://bun.sh");
    process.exit(1);
  }
} catch {
  console.error("Lightcode requires Bun >= 1.3.0, which is not installed.");
  console.error("Install Bun from https://bun.sh or:");
  console.error("  curl -fsSL https://bun.sh/install | bash");
  console.error("  # on Windows (PowerShell):");
  console.error("  powershell -c \\"irm bun.sh/install.ps1 | iex\\"");
  process.exit(1);
}

// Get the directory of this launcher and find cli.js next to it
const launcherDir = path.dirname(process.argv[1]);
const cliPath = path.join(launcherDir, "cli.js");

// Ensure cli.js exists
if (!fs.existsSync(cliPath)) {
  console.error("Error: cli.js not found at " + cliPath);
  process.exit(1);
}

// Exec Bun with the cli.js script using spawnSync for proper argument handling
try {
  const args = process.argv.slice(2);
  const result = spawnSync("bun", [cliPath, ...args], {
    stdio: "inherit",
  });
  process.exit(result.status || 0);
} catch (error) {
  process.exit(error.status || 1);
}
`;

const launcherPath = path.join(distDir, "lightcode.cjs");
writeFileSync(launcherPath, launcherSource, "utf8");

writeFileSync(
  path.join(distDir, "package.json"),
  `${JSON.stringify(
    {
      name: "@kmugalkhod/lightcode",
      version: lightcodeVersion,
      description:
        "Lightcode — a personal AI coding agent with a terminal UI and local session storage.",
      type: "module",
      bin: { lightcode: "./lightcode.cjs" },
      engines: { bun: ">=1.3.0" },
      files: ["cli.js", "lightcode.cjs", "server.js", "README.md"],
      dependencies: externalDependencies,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

if (existsSync(path.join(repoRoot, "README.md"))) {
  writeFileSync(
    path.join(distDir, "README.md"),
    readFileSync(path.join(repoRoot, "README.md"), "utf8"),
    "utf8",
  );
}

console.log(`Built dist/cli.js, dist/server.js, dist/package.json (v${lightcodeVersion})`);
