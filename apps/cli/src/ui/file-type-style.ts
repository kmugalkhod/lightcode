import { cliTheme } from "./cli-theme";

/** A file's visual identity in the tree / tabs: a short type tag + a hue. */
export interface FileTypeStyle {
  /** Short uppercase type tag like an IDE tab (TS, JSON, MD). */
  tag: string;
  /** Semantic color for this file type. */
  color: string;
}

/**
 * Extension → semantic color. One amber accent for TS/TSX (the project's lingua
 * franca); everything else leans on the semantic palette so the tree scans by
 * hue. Unknown extensions fall back to muted chrome.
 */
const colorByExtension: Record<string, string> = {
  ts: cliTheme.accent.primary,
  tsx: cliTheme.accent.primary,
  mts: cliTheme.accent.primary,
  cts: cliTheme.accent.primary,
  js: cliTheme.semantic.warning,
  jsx: cliTheme.semantic.warning,
  mjs: cliTheme.semantic.warning,
  cjs: cliTheme.semantic.warning,
  json: cliTheme.semantic.warning,
  md: cliTheme.text.secondary,
  mdx: cliTheme.text.secondary,
  css: cliTheme.semantic.info,
  scss: cliTheme.semantic.info,
  html: cliTheme.accent.softText,
  py: cliTheme.semantic.info,
  rs: cliTheme.accent.softText,
  go: cliTheme.semantic.info,
  java: cliTheme.semantic.error,
  rb: cliTheme.semantic.error,
  sh: cliTheme.semantic.success,
  bash: cliTheme.semantic.success,
  zsh: cliTheme.semantic.success,
  yml: cliTheme.text.secondary,
  yaml: cliTheme.text.secondary,
  toml: cliTheme.text.secondary,
  sql: cliTheme.semantic.info,
};

/** The basename's extension (lowercased), or "" when there isn't one. */
function extensionOf(path: string): string {
  const base = path.replaceAll("\\", "/").split("/").pop() ?? path;
  if (!base.includes(".")) {
    return "";
  }
  const ext = base.split(".").pop() ?? "";
  // A leading-dot name (".gitignore") splits to its own tail, which is fine.
  return ext === base ? "" : ext.toLowerCase();
}

/** Short uppercase type tag from the extension (TS, JSON, …); "•" when none. */
export function fileTypeTag(path: string): string {
  const ext = extensionOf(path);
  return ext ? ext.slice(0, 3).toUpperCase() : "•";
}

/** Semantic color for the file's type; muted chrome when unknown / extensionless. */
export function fileTypeColor(path: string): string {
  const ext = extensionOf(path);
  return (ext && colorByExtension[ext]) || cliTheme.text.muted;
}

/** Tag + color together — what the tree row and editor tab both render. */
export function fileTypeStyle(path: string): FileTypeStyle {
  return { tag: fileTypeTag(path), color: fileTypeColor(path) };
}
