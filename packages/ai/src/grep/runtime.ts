import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  getDefaultWorkspaceContext,
  resolveWithinWorkspace,
  toWorkspaceRelativePath,
  type WorkspaceContext,
} from "../common/resolve-within-workspace";
import { resolveRipgrep } from "./ripgrep";
import { grepInputSchema, grepOutputSchema } from "./schema";

const execFileAsync = promisify(execFile);
type GrepInput = z.input<typeof grepInputSchema>;
type ParsedGrepInput = z.infer<typeof grepInputSchema>;
type GrepOutput = z.infer<typeof grepOutputSchema>;
type GrepMatch = GrepOutput["matches"][number];
type GrepFile = NonNullable<GrepOutput["files"]>[number];

const fallbackIgnoredDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);
const maxFallbackFileBytes = 1024 * 1024;
/** Files read at once by the fallback search. */
const fallbackReadConcurrency = 32;
/** Minified bundles make single "lines" of megabytes; keep each one readable. */
const maxLineChars = 1_000;
const rgMaxBuffer = 32 * 1024 * 1024;

interface SearchResult {
  matches: GrepMatch[];
  files?: GrepFile[];
  totalMatches: number;
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function getStringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getNumberProperty(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function clipLine(line: string): string {
  const withoutNewline = line.replace(/\r?\n$/, "");
  return withoutNewline.length > maxLineChars
    ? `${withoutNewline.slice(0, maxLineChars)}… [line truncated]`
    : withoutNewline;
}

function relativeOrNull(absolutePath: string, workspaceContext: WorkspaceContext): string | null {
  try {
    return toWorkspaceRelativePath(absolutePath, workspaceContext);
  } catch {
    return null;
  }
}

/** Lines around `lineNumber` that a reader of `lines` (1-based) has. */
function contextAround(
  lineAt: (lineNumber: number) => string | undefined,
  lineNumber: number,
  context: number,
): Pick<GrepMatch, "before" | "after"> {
  if (context <= 0) return {};
  const before: string[] = [];
  for (let current = Math.max(1, lineNumber - context); current < lineNumber; current += 1) {
    const text = lineAt(current);
    if (text !== undefined) before.push(clipLine(text));
  }
  const after: string[] = [];
  for (let current = lineNumber + 1; current <= lineNumber + context; current += 1) {
    const text = lineAt(current);
    if (text === undefined) break;
    after.push(clipLine(text));
  }
  return { before, after };
}

function sortFiles(files: GrepFile[]): GrepFile[] {
  return files.sort((left, right) => right.count - left.count || left.path.localeCompare(right.path));
}

function filesResult(files: GrepFile[], maxResults: number): SearchResult {
  const sorted = sortFiles(files);
  return {
    matches: [],
    files: sorted.slice(0, maxResults),
    totalMatches: sorted.reduce((total, file) => total + file.count, 0),
    truncated: sorted.length > maxResults,
  };
}

// ---------------------------------------------------------------- ripgrep

function ripgrepArgs(parsedInput: ParsedGrepInput): string[] {
  const args = ["--color", "never"];
  if (!parsedInput.caseSensitive) args.push("--ignore-case");
  if (!parsedInput.isRegex) args.push("--fixed-strings");
  if (parsedInput.glob) args.push("--glob", parsedInput.glob);
  return args;
}

/** Null when no ripgrep is available; the caller then uses the fallback. */
async function runRipgrep(args: string[], cwd: string): Promise<string | null> {
  const ripgrep = await resolveRipgrep();
  if (!ripgrep) return null;
  try {
    const result = await execFileAsync(ripgrep.path, args, { cwd, maxBuffer: rgMaxBuffer, windowsHide: true });
    return result.stdout;
  } catch (error) {
    const errorRecord = toRecord(error);
    if (errorRecord.code === 1) {
      // Exit code 1: nothing matched.
      return getStringProperty(errorRecord, "stdout") ?? "";
    }
    if (errorRecord.code === "ENOENT") {
      return null;
    }
    const stderr = getStringProperty(errorRecord, "stderr")?.trim();
    throw new Error(stderr || getStringProperty(errorRecord, "message") || "Failed to execute grep.");
  }
}

async function searchWithRipgrep(
  searchRootPath: string,
  parsedInput: ParsedGrepInput,
  workspaceContext: WorkspaceContext,
): Promise<SearchResult | null> {
  if (parsedInput.outputMode === "files") {
    // --null separates the path from its count, so Windows drive colons are safe.
    const stdout = await runRipgrep(
      [...ripgrepArgs(parsedInput), "--count", "--with-filename", "--null", "--", parsedInput.query, searchRootPath],
      workspaceContext.root,
    );
    if (stdout === null) return null;
    const files: GrepFile[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const separator = line.indexOf("\0");
      if (separator <= 0) continue;
      const rawPath = line.slice(0, separator);
      const count = Number(line.slice(separator + 1));
      const relativePath = relativeOrNull(path.resolve(workspaceContext.root, rawPath), workspaceContext);
      if (relativePath && Number.isInteger(count) && count > 0) files.push({ path: relativePath, count });
    }
    return filesResult(files, parsedInput.maxResults);
  }

  const args = [...ripgrepArgs(parsedInput), "--json", "--line-number", "--column"];
  if (parsedInput.context > 0) args.push("--context", String(parsedInput.context));
  const stdout = await runRipgrep([...args, "--", parsedInput.query, searchRootPath], workspaceContext.root);
  if (stdout === null) return null;

  // Context and match lines per file, so each match can pick up its neighbours.
  const linesByFile = new Map<string, Map<number, string>>();
  const found: Array<{ rawPath: string; lineNumber: number; column: number; line: string }> = [];
  let totalMatches = 0;
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (!isRecord(event) || (event.type !== "match" && event.type !== "context")) continue;
    const data = toRecord(event.data);
    const rawPath = getStringProperty(toRecord(data.path), "text");
    const lineText = getStringProperty(toRecord(data.lines), "text");
    const lineNumber = getNumberProperty(data, "line_number");
    if (!rawPath || lineText === undefined || lineNumber === undefined) continue;

    let fileLines = linesByFile.get(rawPath);
    if (!fileLines) {
      fileLines = new Map();
      linesByFile.set(rawPath, fileLines);
    }
    fileLines.set(lineNumber, lineText);

    if (event.type === "match") {
      totalMatches += 1;
      if (found.length < parsedInput.maxResults) {
        const submatches = Array.isArray(data.submatches) ? data.submatches : [];
        const start = submatches.length > 0 ? (getNumberProperty(toRecord(submatches[0]), "start") ?? 0) : 0;
        found.push({ rawPath, lineNumber, column: start + 1, line: lineText });
      }
    }
  }

  const matches: GrepMatch[] = [];
  for (const match of found) {
    const relativePath = relativeOrNull(path.resolve(workspaceContext.root, match.rawPath), workspaceContext);
    if (!relativePath) continue;
    const fileLines = linesByFile.get(match.rawPath);
    matches.push({
      path: relativePath,
      lineNumber: match.lineNumber,
      column: match.column,
      line: clipLine(match.line),
      ...contextAround((lineNumber) => fileLines?.get(lineNumber), match.lineNumber, parsedInput.context),
    });
  }
  return { matches, totalMatches, truncated: totalMatches > matches.length };
}

// --------------------------------------------------------------- fallback

/**
 * Files git would show (tracked plus untracked, minus .gitignore'd), the same
 * set ripgrep searches. Null outside a git work tree or without git.
 */
async function listGitFiles(searchRootPath: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
      { cwd: searchRootPath, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    return [...new Set(stdout.split("\0").filter(Boolean))]
      .filter((file) => !file.split("/").some((part) => fallbackIgnoredDirectories.has(part)))
      .map((file) => path.join(searchRootPath, file));
  } catch {
    return null;
  }
}

async function walkFiles(searchRootPath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(searchRootPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(searchRootPath, entry.name);
      if (entry.isDirectory()) {
        return fallbackIgnoredDirectories.has(entry.name) ? [] : walkFiles(entryPath);
      }
      return entry.isFile() ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

async function collectSearchFiles(searchRootPath: string): Promise<string[]> {
  let searchRootStat;
  try {
    searchRootStat = await stat(searchRootPath);
  } catch {
    return [];
  }
  if (searchRootStat.isFile()) return [searchRootPath];
  if (!searchRootStat.isDirectory()) return [];
  // Git lists nothing for a folder it ignores; one asked for by name is still searched.
  const gitFiles = await listGitFiles(searchRootPath);
  const files = gitFiles && gitFiles.length > 0 ? gitFiles : await walkFiles(searchRootPath);
  return files.sort((left, right) => left.localeCompare(right));
}

/**
 * ripgrep-style glob test: a pattern without "/" matches the file name at any
 * depth, one with "/" matches the path under the search root; "!" negates.
 */
export function createGlobFilter(glob: string | undefined): (relativePath: string) => boolean {
  if (!glob) return () => true;
  const negated = glob.startsWith("!");
  const pattern = negated ? glob.slice(1) : glob;
  const matcher = new Bun.Glob(pattern);
  const byName = !pattern.includes("/");
  return (relativePath) => {
    const normalized = relativePath.replaceAll("\\", "/");
    const subject = byName ? normalized.slice(normalized.lastIndexOf("/") + 1) : normalized;
    return matcher.match(subject) !== negated;
  };
}

function createLineMatcher(parsedInput: ParsedGrepInput): (line: string) => number | null {
  if (parsedInput.isRegex) {
    let matcher: RegExp;
    try {
      matcher = new RegExp(parsedInput.query, parsedInput.caseSensitive ? "" : "i");
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Invalid regular expression.");
    }
    return (line) => {
      const match = matcher.exec(line);
      return match ? match.index + 1 : null;
    };
  }
  const needle = parsedInput.caseSensitive ? parsedInput.query : parsedInput.query.toLowerCase();
  return (line) => {
    const index = (parsedInput.caseSensitive ? line : line.toLowerCase()).indexOf(needle);
    return index >= 0 ? index + 1 : null;
  };
}

async function readSearchableLines(filePath: string): Promise<string[] | null> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size > maxFallbackFileBytes) return null;
    const content = await readFile(filePath, "utf8");
    return content.includes("\0") ? null : content.split(/\r?\n/);
  } catch {
    return null;
  }
}

async function searchWithFallback(
  searchRootPath: string,
  parsedInput: ParsedGrepInput,
  workspaceContext: WorkspaceContext,
): Promise<SearchResult> {
  const matchLine = createLineMatcher(parsedInput);
  const globFilter = createGlobFilter(parsedInput.glob);
  const searchRootIsFile = (await stat(searchRootPath).catch(() => null))?.isFile() ?? false;
  const files = (await collectSearchFiles(searchRootPath)).filter(
    (filePath) => searchRootIsFile || globFilter(path.relative(searchRootPath, filePath)),
  );

  const matches: GrepMatch[] = [];
  const counts: GrepFile[] = [];
  let totalMatches = 0;
  for (let start = 0; start < files.length; start += fallbackReadConcurrency) {
    const batch = files.slice(start, start + fallbackReadConcurrency);
    const contents = await Promise.all(batch.map((filePath) => readSearchableLines(filePath)));
    for (const [index, lines] of contents.entries()) {
      if (!lines) continue;
      const relativePath = relativeOrNull(batch[index]!, workspaceContext);
      if (!relativePath) continue;
      let fileCount = 0;
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const column = matchLine(lines[lineIndex]!);
        if (column === null) continue;
        fileCount += 1;
        totalMatches += 1;
        if (parsedInput.outputMode === "content" && matches.length < parsedInput.maxResults) {
          matches.push({
            path: relativePath,
            lineNumber: lineIndex + 1,
            column,
            line: clipLine(lines[lineIndex]!),
            ...contextAround((lineNumber) => lines[lineNumber - 1], lineIndex + 1, parsedInput.context),
          });
        }
      }
      if (fileCount > 0) counts.push({ path: relativePath, count: fileCount });
    }
    // Content mode stops once the page is full; files mode counts everything.
    if (parsedInput.outputMode === "content" && matches.length >= parsedInput.maxResults) {
      const filesLeft = start + fallbackReadConcurrency < files.length;
      return { matches, totalMatches, truncated: filesLeft || totalMatches > matches.length };
    }
  }

  return parsedInput.outputMode === "files"
    ? filesResult(counts, parsedInput.maxResults)
    : { matches, totalMatches, truncated: totalMatches > matches.length };
}

export async function executeGrep(
  input: GrepInput,
  workspaceContext: WorkspaceContext = getDefaultWorkspaceContext(),
): Promise<GrepOutput> {
  const parsedInput = grepInputSchema.parse(input);
  const searchRootPath = resolveWithinWorkspace(parsedInput.path, {
    context: workspaceContext,
  });
  const result =
    (await searchWithRipgrep(searchRootPath, parsedInput, workspaceContext)) ??
    (await searchWithFallback(searchRootPath, parsedInput, workspaceContext));

  return grepOutputSchema.parse({
    query: parsedInput.query,
    path: toWorkspaceRelativePath(searchRootPath, workspaceContext),
    ...result,
  });
}
