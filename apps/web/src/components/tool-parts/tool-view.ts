import { z } from "zod";

/**
 * What a tool call shows by default. Outputs are untrusted payloads, so each
 * known tool is parsed with zod here; anything that does not match falls back
 * to the generic view (raw JSON stays behind "Details").
 */
export type ToolView =
  | { kind: "diff"; path: string; diff: string; added: number; removed: number; created: boolean }
  | { kind: "command"; command: string; exitCode: number; stdout: string; stderr: string; truncated: boolean }
  | { kind: "read"; path: string; startLine: number; endLine: number; totalLines: number }
  | { kind: "matches"; label: string; total: number; truncated: boolean; items: string[] }
  | { kind: "generic" };

const diffOutputSchema = z.object({
  path: z.string(),
  diff: z.string().optional(),
  created: z.boolean().optional(),
});

const bashOutputSchema = z.object({
  command: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  truncated: z.boolean(),
});

const readOutputSchema = z.object({
  path: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  totalLines: z.number().int(),
});

const grepOutputSchema = z.object({
  query: z.string(),
  matches: z.array(
    z.object({ path: z.string(), lineNumber: z.number().int(), line: z.string() }),
  ),
  totalMatches: z.number().int(),
  truncated: z.boolean(),
});

const pathListOutputSchema = z.object({
  matches: z.array(z.object({ path: z.string() })).optional(),
  entries: z.array(z.object({ path: z.string() })).optional(),
  totalMatches: z.number().int().optional(),
  totalEntries: z.number().int().optional(),
  truncated: z.boolean(),
});

const maximumListedItems = 40;

export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

export function toolView(toolName: string, output: unknown): ToolView {
  if (toolName === "edit_file" || toolName === "write_file") {
    const parsed = diffOutputSchema.safeParse(output);
    if (parsed.success && parsed.data.diff?.trim()) {
      return {
        kind: "diff",
        path: parsed.data.path,
        diff: parsed.data.diff,
        created: parsed.data.created ?? false,
        ...countDiffLines(parsed.data.diff),
      };
    }
  }
  if (toolName === "bash") {
    const parsed = bashOutputSchema.safeParse(output);
    if (parsed.success) return { kind: "command", ...parsed.data };
  }
  if (toolName === "read_file") {
    const parsed = readOutputSchema.safeParse(output);
    if (parsed.success) return { kind: "read", ...parsed.data };
  }
  if (toolName === "grep") {
    const parsed = grepOutputSchema.safeParse(output);
    if (parsed.success) {
      return {
        kind: "matches",
        label: parsed.data.totalMatches === 1 ? "match" : "matches",
        total: parsed.data.totalMatches,
        truncated: parsed.data.truncated,
        items: parsed.data.matches
          .slice(0, maximumListedItems)
          .map((match) => `${match.path}:${match.lineNumber}  ${match.line.trim()}`),
      };
    }
  }
  if (toolName === "glob_search" || toolName === "list_files") {
    const parsed = pathListOutputSchema.safeParse(output);
    const items = parsed.success
      ? (parsed.data.matches ?? parsed.data.entries ?? [])
      : null;
    if (parsed.success && items) {
      const total = parsed.data.totalMatches ?? parsed.data.totalEntries ?? items.length;
      return {
        kind: "matches",
        label: toolName === "list_files"
          ? total === 1 ? "entry" : "entries"
          : total === 1 ? "file" : "files",
        total,
        truncated: parsed.data.truncated,
        items: items.slice(0, maximumListedItems).map((item) => item.path),
      };
    }
  }
  return { kind: "generic" };
}

/** Short result shown next to the tool name, e.g. "+12 −3" or "exit 1". */
export function toolViewBadge(view: ToolView): string | null {
  if (view.kind === "diff") return view.created ? `new · +${view.added}` : `+${view.added} −${view.removed}`;
  if (view.kind === "command") return `exit ${view.exitCode}`;
  if (view.kind === "read") return `lines ${view.startLine}–${view.endLine} of ${view.totalLines}`;
  if (view.kind === "matches") return `${view.total}${view.truncated ? "+" : ""} ${view.label}`;
  return null;
}
