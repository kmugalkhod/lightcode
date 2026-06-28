import { SyntaxStyle } from "@opentui/core";
import { cliTheme } from "./cli-theme";

/**
 * Tree-sitter highlight styles mapped from the CLI theme. Unknown scope
 * names are ignored by the highlighter, so unsupported grammars simply fall
 * back to the default style.
 */
export const codeSyntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: cliTheme.text.primary },
  keyword: { fg: cliTheme.accent.primary, bold: true },
  "keyword.return": { fg: cliTheme.accent.primary, bold: true },
  "keyword.function": { fg: cliTheme.accent.primary, bold: true },
  "keyword.operator": { fg: cliTheme.accent.primary },
  "keyword.import": { fg: cliTheme.accent.primary, bold: true },
  "keyword.conditional": { fg: cliTheme.accent.primary, bold: true },
  "keyword.repeat": { fg: cliTheme.accent.primary, bold: true },
  string: { fg: cliTheme.semantic.success },
  "string.special": { fg: cliTheme.semantic.success },
  "string.escape": { fg: cliTheme.accent.softText },
  "string.regexp": { fg: cliTheme.semantic.success },
  number: { fg: cliTheme.semantic.warning },
  "number.float": { fg: cliTheme.semantic.warning },
  boolean: { fg: cliTheme.semantic.warning },
  constant: { fg: cliTheme.semantic.warning },
  "constant.builtin": { fg: cliTheme.semantic.warning },
  comment: { fg: cliTheme.text.muted, italic: true },
  "comment.documentation": { fg: cliTheme.text.muted, italic: true },
  function: { fg: cliTheme.semantic.info },
  "function.method": { fg: cliTheme.semantic.info },
  "function.call": { fg: cliTheme.semantic.info },
  "function.builtin": { fg: cliTheme.semantic.info },
  "function.macro": { fg: cliTheme.semantic.info },
  constructor: { fg: cliTheme.accent.softText },
  type: { fg: cliTheme.accent.softText },
  "type.builtin": { fg: cliTheme.accent.softText },
  "type.definition": { fg: cliTheme.accent.softText },
  namespace: { fg: cliTheme.accent.softText },
  module: { fg: cliTheme.accent.softText },
  property: { fg: cliTheme.semantic.info },
  field: { fg: cliTheme.semantic.info },
  attribute: { fg: cliTheme.semantic.warning },
  label: { fg: cliTheme.semantic.warning },
  tag: { fg: cliTheme.accent.primary },
  "tag.attribute": { fg: cliTheme.semantic.warning },
  variable: { fg: cliTheme.text.primary },
  "variable.builtin": { fg: cliTheme.semantic.warning },
  "variable.parameter": { fg: cliTheme.text.secondary },
  "variable.member": { fg: cliTheme.semantic.info },
  operator: { fg: cliTheme.text.secondary },
  punctuation: { fg: cliTheme.text.secondary },
  "punctuation.bracket": { fg: cliTheme.text.secondary },
  "punctuation.delimiter": { fg: cliTheme.text.secondary },
  "punctuation.special": { fg: cliTheme.accent.softText },
});

const filetypeByExtension: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  css: "css",
  html: "html",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  rb: "ruby",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  prisma: "prisma",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
};

export function inferFiletype(filePath: string): string | undefined {
  const extension = filePath.split(".").pop()?.toLowerCase();
  return extension ? filetypeByExtension[extension] : undefined;
}
