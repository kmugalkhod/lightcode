import { existsSync } from "node:fs";
import { join } from "node:path";
import { getTreeSitterClient } from "@opentui/core";

/**
 * Extra tree-sitter grammars we can highlight in the file viewer / diffs beyond
 * the few OpenTUI ships (JS/TS/Markdown/Zig). Each entry maps to asset files
 * under `apps/cli/assets/grammars/<dir>/`. The filetype strings must match what
 * `inferFiletype` returns. Populate the assets with `bun scripts/fetch-grammars.ts`.
 */
export interface GrammarSpec {
  filetype: string;
  aliases?: string[];
  dir: string;
  wasm: string;
}

export const GRAMMARS: GrammarSpec[] = [
  { filetype: "python", dir: "python", wasm: "tree-sitter-python.wasm" },
  { filetype: "json", dir: "json", wasm: "tree-sitter-json.wasm" },
  { filetype: "bash", aliases: ["sh"], dir: "bash", wasm: "tree-sitter-bash.wasm" },
  { filetype: "css", dir: "css", wasm: "tree-sitter-css.wasm" },
  { filetype: "html", dir: "html", wasm: "tree-sitter-html.wasm" },
  { filetype: "yaml", dir: "yaml", wasm: "tree-sitter-yaml.wasm" },
  { filetype: "go", dir: "go", wasm: "tree-sitter-go.wasm" },
  { filetype: "rust", dir: "rust", wasm: "tree-sitter-rust.wasm" },
  { filetype: "c", dir: "c", wasm: "tree-sitter-c.wasm" },
  { filetype: "cpp", dir: "cpp", wasm: "tree-sitter-cpp.wasm" },
];

/**
 * Locate the bundled grammars directory. In dev it sits next to the source
 * (`apps/cli/assets/grammars`); in the built CLI it's copied beside `cli.js`
 * (`dist/assets/grammars`). Returns null when neither exists.
 */
export function resolveGrammarsDir(): string | null {
  const candidates = [
    // dist: <dist>/cli.js → <dist>/assets/grammars
    join(import.meta.dir, "assets", "grammars"),
    join(import.meta.dir, "..", "assets", "grammars"),
    // dev: apps/cli/src/ui → apps/cli/assets/grammars
    join(import.meta.dir, "..", "..", "assets", "grammars"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) {
      return dir;
    }
  }
  return null;
}

/**
 * Register any grammars whose asset files are present, on OpenTUI's shared
 * tree-sitter client (so both `<code>` and `<diff>` pick them up). Fail-closed:
 * missing/broken grammars are skipped and never crash startup. Wasm is loaded
 * lazily by the worker on first use, so this is cheap to call at boot.
 *
 * Returns the list of filetypes that were registered.
 */
export function registerExtraGrammars(): string[] {
  const dir = resolveGrammarsDir();
  if (!dir) {
    return [];
  }

  let client: ReturnType<typeof getTreeSitterClient>;
  try {
    client = getTreeSitterClient();
  } catch {
    return [];
  }

  const registered: string[] = [];
  for (const grammar of GRAMMARS) {
    const wasmPath = join(dir, grammar.dir, grammar.wasm);
    const highlightsPath = join(dir, grammar.dir, "highlights.scm");
    if (!existsSync(wasmPath) || !existsSync(highlightsPath)) {
      continue;
    }
    try {
      client.addFiletypeParser({
        filetype: grammar.filetype,
        aliases: grammar.aliases,
        wasm: wasmPath,
        queries: { highlights: [highlightsPath] },
      });
      registered.push(grammar.filetype);
    } catch {
      // A single bad grammar must never break the others or startup.
    }
  }
  return registered;
}
