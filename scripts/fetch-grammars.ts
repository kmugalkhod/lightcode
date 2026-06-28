#!/usr/bin/env bun
/**
 * Download the tree-sitter grammars used by the in-app file viewer / diff
 * highlighter into apps/cli/assets/grammars/<lang>/. Run once:
 *
 *   bun scripts/fetch-grammars.ts
 *
 * Sources:
 *  - <lang>.wasm  ← tree-sitter-wasms (prebuilt, web-tree-sitter compatible)
 *  - highlights.scm ← nvim-treesitter queries (MIT)
 *
 * Grammars are NOT committed; this script vendors them locally. After running,
 * start the app and open a file of each language to verify highlighting (watch
 * stderr for tree-sitter worker errors — an incompatible wasm would log there).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const TS_WASMS_VERSION = "0.1.12";
const NVIM_REF = "master";

// filetype → { wasm grammar name, nvim-treesitter query dir, optional query URL
// override }. The wasm comes from tree-sitter-wasms (prebuilt). Highlight queries
// default to nvim-treesitter master, with a per-language override where master's
// queries don't match the prebuilt grammar version. Languages whose queries
// don't match simply render plain (the grammar still loads, no error) — verified
// good today: python, json, css, go. Others may render plain until their query
// source is pinned to the matching grammar version.
const GRAMMARS: Array<{
  dir: string;
  wasm: string;
  queryLang: string;
  queryUrl?: string;
}> = [
  { dir: "python", wasm: "python", queryLang: "python" },
  { dir: "json", wasm: "json", queryLang: "json" },
  { dir: "bash", wasm: "bash", queryLang: "bash" },
  { dir: "css", wasm: "css", queryLang: "css" },
  { dir: "html", wasm: "html", queryLang: "html" },
  { dir: "yaml", wasm: "yaml", queryLang: "yaml" },
  {
    dir: "go",
    wasm: "go",
    queryLang: "go",
    queryUrl:
      "https://raw.githubusercontent.com/tree-sitter/tree-sitter-go/v0.20.0/queries/highlights.scm",
  },
  { dir: "rust", wasm: "rust", queryLang: "rust" },
  { dir: "c", wasm: "c", queryLang: "c" },
  { dir: "cpp", wasm: "cpp", queryLang: "cpp" },
];

const ASSETS_ROOT = join(import.meta.dir, "..", "apps", "cli", "assets", "grammars");

async function download(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  ✗ ${res.status} ${url}`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (error) {
    console.warn(`  ✗ ${error instanceof Error ? error.message : error} ${url}`);
    return null;
  }
}

async function writeAsset(path: string, data: Buffer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

let ok = 0;
for (const g of GRAMMARS) {
  console.log(`• ${g.dir}`);
  const wasmUrl = `https://unpkg.com/tree-sitter-wasms@${TS_WASMS_VERSION}/out/tree-sitter-${g.wasm}.wasm`;
  const scmUrl =
    g.queryUrl ??
    `https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/${NVIM_REF}/queries/${g.queryLang}/highlights.scm`;

  const [wasm, scm] = await Promise.all([download(wasmUrl), download(scmUrl)]);
  if (!wasm || !scm) {
    console.warn(`  skipped ${g.dir} (missing asset)`);
    continue;
  }
  await writeAsset(join(ASSETS_ROOT, g.dir, `tree-sitter-${g.wasm}.wasm`), wasm);
  await writeAsset(join(ASSETS_ROOT, g.dir, "highlights.scm"), scm);
  console.log(`  ✓ ${(wasm.byteLength / 1024).toFixed(0)}KB wasm + ${scm.toString("utf8").split("\n").length} query lines`);
  ok += 1;
}

console.log(`\nDone: ${ok}/${GRAMMARS.length} grammars in ${ASSETS_ROOT}`);
