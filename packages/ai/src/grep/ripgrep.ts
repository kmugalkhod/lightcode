import { existsSync } from "node:fs";
import path from "node:path";

export type RipgrepSource = "env" | "bundled" | "path";

export interface ResolvedRipgrep {
  path: string;
  source: RipgrepSource;
}

let bundledRipgrep: Promise<string | null> | null = null;

/**
 * The ripgrep binary shipped with Lightcode: `@vscode/ripgrep` pulls in only
 * this platform's binary from the npm registry, the way the package ships
 * Bun. Its module throws when that binary is missing, hence the try.
 */
function loadBundledRipgrep(): Promise<string | null> {
  bundledRipgrep ??= (async () => {
    try {
      // A variable specifier keeps bundlers from inlining it: the package is
      // a runtime dependency resolved from node_modules beside Lightcode.
      const specifier = "@vscode/ripgrep";
      const loaded = (await import(specifier)) as { rgPath?: unknown };
      return typeof loaded.rgPath === "string" && existsSync(loaded.rgPath) ? loaded.rgPath : null;
    } catch {
      return null;
    }
  })();
  return bundledRipgrep;
}

/**
 * The ripgrep to search with. LIGHTCODE_RIPGREP picks a binary, or "off" for
 * the built-in search; otherwise the bundled copy, then `rg` on PATH. Null
 * means the built-in search.
 */
export async function resolveRipgrep(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedRipgrep | null> {
  const override = env.LIGHTCODE_RIPGREP?.trim();
  if (override) {
    return override.toLowerCase() === "off" ? null : { path: override, source: "env" };
  }
  const bundled = await loadBundledRipgrep();
  if (bundled) return { path: bundled, source: "bundled" };
  const onPath = Bun.which("rg");
  return onPath ? { path: onPath, source: "path" } : null;
}

function pathKey(env: NodeJS.ProcessEnv): string {
  // Windows spells it "Path"; adding a second "PATH" would leave the child two.
  return Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
}

/**
 * `env` with the bundled ripgrep's folder appended to PATH, so `rg` works in
 * shell commands. Appended, so an `rg` the user installed still wins.
 */
export async function withBundledRipgrepOnPath(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const bundled = await loadBundledRipgrep();
  if (!bundled) return env;
  const directory = path.dirname(bundled);
  const key = pathKey(env);
  const entries = (env[key] ?? "").split(path.delimiter).filter(Boolean);
  const normalize = (entry: string) =>
    process.platform === "win32" ? path.resolve(entry).toLowerCase() : path.resolve(entry);
  if (entries.some((entry) => normalize(entry) === normalize(directory))) return env;
  return { ...env, [key]: [...entries, directory].join(path.delimiter) };
}

/** One line for diagnostics: which search the grep tool uses. */
export async function describeSearchEngine(env: NodeJS.ProcessEnv = process.env): Promise<{
  ripgrep: boolean;
  summary: string;
  detail: string | null;
}> {
  const resolved = await resolveRipgrep(env);
  if (!resolved) {
    return {
      ripgrep: false,
      summary:
        env.LIGHTCODE_RIPGREP?.trim().toLowerCase() === "off"
          ? "Built-in search (ripgrep turned off by LIGHTCODE_RIPGREP)."
          : "Built-in search: ripgrep was not found, so searches are slower on large repositories.",
      detail: null,
    };
  }
  const where = {
    env: "from LIGHTCODE_RIPGREP",
    bundled: "bundled with Lightcode",
    path: "on PATH",
  }[resolved.source];
  return { ripgrep: true, summary: `ripgrep (${where}).`, detail: resolved.path };
}
