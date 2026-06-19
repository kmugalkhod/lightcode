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

/**
 * The Bun version to ship as a dependency of the published package, so that
 * `npm install -g` pulls in a runtime instead of requiring a separate Bun
 * install. Pinned to the repo's own Bun (root packageManager / engines.bun).
 */
function resolveBunVersion(): string {
  const rootManifest = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ) as { packageManager?: string; engines?: { bun?: string } };

  const fromPackageManager = rootManifest.packageManager?.match(/^bun@(.+)$/);
  if (fromPackageManager?.[1]) {
    return fromPackageManager[1];
  }

  const fromEngines = rootManifest.engines?.bun?.replace(/[^0-9.]/g, "");
  return fromEngines && fromEngines.length > 0 ? fromEngines : "1.3.13";
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
const bunVersion = resolveBunVersion();
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
const os = require("os");

// Resolve a usable Bun (>= 1.3.0). Prefer the Bun bundled as a dependency of
// this package (so a plain \`npm install -g\` works with no separate Bun
// install), then fall back to a Bun already on PATH.
function isUsableBun(bunCmd) {
  try {
    const result = spawnSync(bunCmd, ["--version"], { encoding: "utf8" });
    if (result.status !== 0 || !result.stdout) {
      return false;
    }
    const [major, minor] = result.stdout.trim().split(".").map(Number);
    return major > 1 || (major === 1 && minor >= 3);
  } catch {
    return false;
  }
}

function resolveBun() {
  // __dirname is the realpath of this launcher even when invoked via npm's
  // global bin symlink (process.argv[1] would be the symlink path on macOS/Linux).
  const launcherDir = __dirname;
  const candidates = [];

  // Bun shipped as a dependency, inside this package's own node_modules. The
  // npm "bun" package names its executable bin/bun.exe on EVERY platform
  // (macOS and Linux included), so read the real path from its "bin" field
  // rather than guessing a filename.
  try {
    const bunPkgPath = require.resolve("bun/package.json", {
      paths: [launcherDir],
    });
    const bunDir = path.dirname(bunPkgPath);
    const bin = JSON.parse(fs.readFileSync(bunPkgPath, "utf8")).bin;
    const rel = typeof bin === "string" ? bin : bin && bin.bun;
    if (rel) {
      candidates.push(path.join(bunDir, rel));
    }
  } catch {}

  // npm's bin shim (symlink) and conventional names, as fallbacks.
  const shim = process.platform === "win32" ? "bun.exe" : "bun";
  candidates.push(path.join(launcherDir, "node_modules", ".bin", shim));
  candidates.push(path.join(launcherDir, "node_modules", "bun", "bin", "bun.exe"));
  candidates.push(path.join(launcherDir, "node_modules", "bun", "bin", "bun"));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && isUsableBun(candidate)) {
      return candidate;
    }
  }

  // Fall back to a system Bun on PATH.
  if (isUsableBun("bun")) {
    return "bun";
  }

  return null;
}

const bunPath = resolveBun();
if (!bunPath) {
  console.error("Lightcode requires Bun >= 1.3.0, which could not be found.");
  console.error("Install Bun from https://bun.sh or:");
  console.error("  curl -fsSL https://bun.sh/install | bash");
  console.error("  # on Windows (PowerShell):");
  console.error("  powershell -c \\"irm bun.sh/install.ps1 | iex\\"");
  process.exit(1);
}

// On Windows, inject system root certificates into Bun via NODE_EXTRA_CA_CERTS.
// Bun uses its own TLS stack and does not read the Windows certificate store,
// so corporate SSL proxies (which install their CA into Windows) are invisible
// to Bun unless we forward the certs explicitly.
// Strategy: use PowerShell only to export raw DER .cer files; do all PEM
// formatting in Node.js where string/encoding handling is reliable.
if (process.platform === "win32" && !process.env.NODE_EXTRA_CA_CERTS) {
  try {
    const tmpDir = os.tmpdir();
    const cerDir = path.join(tmpDir, "lightcode-certs");
    const pemFile = path.join(tmpDir, "lightcode-win-ca.pem");
    const ps1File = path.join(tmpDir, "lightcode-cert-export.ps1");

    if (!fs.existsSync(cerDir)) fs.mkdirSync(cerDir, { recursive: true });

    // Forward slashes work in PowerShell and avoid backslash escaping issues
    const cerDirFwd = cerDir.replace(/\\\\/g, "/");
    const psLines = [
      "$i = 0",
      'foreach ($s in @("Root", "CA")) {',
      '  try {',
      '    foreach ($c in (Get-ChildItem "Cert:\\\\LocalMachine\\\\$s" -EA Stop)) {',
      '      Export-Certificate -Cert $c -FilePath "' + cerDirFwd + '/$i.cer" -Type CERT | Out-Null',
      '      $i++',
      '    }',
      '  } catch {}',
      '}',
    ];
    fs.writeFileSync(ps1File, psLines.join("\\n"), "utf8");
    spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1File], { stdio: "pipe" });
    try { fs.unlinkSync(ps1File); } catch {}

    // Convert DER .cer files to PEM entirely in Node.js
    const cerFiles = fs.existsSync(cerDir) ? fs.readdirSync(cerDir).filter(function(f) { return f.endsWith(".cer"); }) : [];
    const pems = cerFiles.map(function(f) {
      const der = fs.readFileSync(path.join(cerDir, f));
      const b64 = der.toString("base64").match(/.{1,64}/g).join("\\n");
      return "-----BEGIN CERTIFICATE-----\\n" + b64 + "\\n-----END CERTIFICATE-----";
    });

    if (pems.length > 0) {
      fs.writeFileSync(pemFile, pems.join("\\n") + "\\n", "ascii");
      process.env.NODE_EXTRA_CA_CERTS = pemFile;
    }

    // Cleanup individual cert files
    cerFiles.forEach(function(f) { try { fs.unlinkSync(path.join(cerDir, f)); } catch {} });
    try { fs.rmdirSync(cerDir); } catch {}
  } catch {
    // cert export failed — Bun uses its own bundled roots
  }
}

// Get the directory of this launcher and find cli.js next to it. Use __dirname
// (realpath-resolved) so this works when run via npm's global bin symlink.
const cliPath = path.join(__dirname, "cli.js");

// Ensure cli.js exists
if (!fs.existsSync(cliPath)) {
  console.error("Error: cli.js not found at " + cliPath);
  process.exit(1);
}

// Exec Bun with the cli.js script using spawnSync for proper argument handling
try {
  const args = process.argv.slice(2);
  const result = spawnSync(bunPath, [cliPath, ...args], {
    stdio: "inherit",
    env: process.env,
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
      license: "MIT",
      bin: { lightcode: "./lightcode.cjs" },
      engines: { bun: ">=1.3.0" },
      files: ["cli.js", "lightcode.cjs", "server.js", "README.md", "LICENSE"],
      // Ship Bun itself so `npm install -g` is self-contained (the npm "bun"
      // package vendors the right native binary per platform). The launcher
      // prefers this bundled Bun and falls back to a system Bun on PATH.
      dependencies: { bun: bunVersion, ...externalDependencies },
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

if (existsSync(path.join(repoRoot, "LICENSE"))) {
  writeFileSync(
    path.join(distDir, "LICENSE"),
    readFileSync(path.join(repoRoot, "LICENSE"), "utf8"),
    "utf8",
  );
}

console.log(`Built dist/cli.js, dist/server.js, dist/package.json (v${lightcodeVersion})`);
