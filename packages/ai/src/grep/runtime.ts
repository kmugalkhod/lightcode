import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { resolveWithinWorkspace, toWorkspaceRelativePath, WORKSPACE } from "../common/resolve-within-workspace";
import { grepInputSchema, grepOutputSchema } from "./schema";

const execFileAsync = promisify(execFile);
type GrepInput = z.input<typeof grepInputSchema>;
type GrepOutput = z.infer<typeof grepOutputSchema>;
type GrepMatch = GrepOutput["matches"][number];

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

function parseMatchEvent(
  line: string,
): {
  rawPath: string;
  lineText: string;
  lineNumber: number;
  firstSubmatchStart: number;
} | null {
  let parsedLine: unknown;
  try {
    parsedLine = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isRecord(parsedLine) || parsedLine.type !== "match") {
    return null;
  }

  const data = toRecord(parsedLine.data);
  const pathNode = toRecord(data.path);
  const linesNode = toRecord(data.lines);
  const rawPath = getStringProperty(pathNode, "text");
  const lineText = getStringProperty(linesNode, "text");
  const lineNumber = getNumberProperty(data, "line_number");

  if (!rawPath || lineText === undefined || lineNumber === undefined) {
    return null;
  }

  const submatches = Array.isArray(data.submatches) ? data.submatches : [];
  const firstSubmatch = submatches.length > 0 ? toRecord(submatches[0]) : null;
  const firstSubmatchStart = firstSubmatch ? getNumberProperty(firstSubmatch, "start") ?? 0 : 0;

  return {
    rawPath,
    lineText,
    lineNumber,
    firstSubmatchStart,
  };
}

function parseRgMatches(stdout: string, maxResults: number): GrepOutput["matches"] {
  const matches: Array<{ path: string; lineNumber: number; column: number; line: string }> = [];
  const lines = stdout.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const event = parseMatchEvent(trimmed);
    if (!event) {
      continue;
    }

    const absolutePath = path.isAbsolute(event.rawPath) ? event.rawPath : path.resolve(WORKSPACE, event.rawPath);
    let relativePath: string;
    try {
      relativePath = toWorkspaceRelativePath(absolutePath);
    } catch {
      continue;
    }

    const column = event.firstSubmatchStart + 1;
    matches.push({
      path: relativePath,
      lineNumber: event.lineNumber,
      column,
      line: event.lineText.replace(/\r?\n$/, ""),
    });

    if (matches.length >= maxResults) {
      break;
    }
  }

  return matches;
}

function getFirstMatchColumn(
  line: string,
  query: string,
  isRegex: boolean,
  caseSensitive: boolean,
): number | null {
  if (isRegex) {
    let matcher: RegExp;
    try {
      matcher = new RegExp(query, caseSensitive ? "" : "i");
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Invalid regular expression.");
    }

    const match = matcher.exec(line);
    return match ? match.index + 1 : null;
  }

  const haystack = caseSensitive ? line : line.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const index = haystack.indexOf(needle);
  return index >= 0 ? index + 1 : null;
}

async function collectSearchFiles(searchRootPath: string): Promise<string[]> {
  let searchRootStat;
  try {
    searchRootStat = await stat(searchRootPath);
  } catch {
    return [];
  }

  if (searchRootStat.isFile()) {
    return [searchRootPath];
  }

  if (!searchRootStat.isDirectory()) {
    return [];
  }

  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(searchRootPath, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory() && fallbackIgnoredDirectories.has(entry.name)) {
      continue;
    }

    const entryPath = path.join(searchRootPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectSearchFiles(entryPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function searchFileWithFallback(
  filePath: string,
  parsedInput: z.infer<typeof grepInputSchema>,
  matches: GrepMatch[],
): Promise<boolean> {
  const fileStat = await stat(filePath);
  if (fileStat.size > maxFallbackFileBytes) {
    return false;
  }

  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return false;
  }

  if (content.includes("\0")) {
    return false;
  }

  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const column = getFirstMatchColumn(
      line,
      parsedInput.query,
      parsedInput.isRegex,
      parsedInput.caseSensitive,
    );

    if (column === null) {
      continue;
    }

    matches.push({
      path: toWorkspaceRelativePath(filePath),
      lineNumber: index + 1,
      column,
      line,
    });

    if (matches.length >= parsedInput.maxResults) {
      return true;
    }
  }

  return false;
}

async function grepWithFallback(
  searchRootPath: string,
  parsedInput: z.infer<typeof grepInputSchema>,
): Promise<GrepOutput["matches"]> {
  const matches: GrepMatch[] = [];
  const files = await collectSearchFiles(searchRootPath);

  for (const filePath of files) {
    const reachedLimit = await searchFileWithFallback(filePath, parsedInput, matches);
    if (reachedLimit) {
      break;
    }
  }

  return matches;
}

export async function executeGrep(input: GrepInput): Promise<GrepOutput> {
  const parsedInput = grepInputSchema.parse(input);
  const searchRootPath = resolveWithinWorkspace(parsedInput.path);
  const relativeSearchRootPath = toWorkspaceRelativePath(searchRootPath);

  const args = ["--json", "--line-number", "--column", "--no-heading", "--color", "never"];

  if (!parsedInput.caseSensitive) {
    args.push("--ignore-case");
  }

  if (!parsedInput.isRegex) {
    args.push("--fixed-strings");
  }

  args.push(parsedInput.query, searchRootPath);

  let stdout = "";

  try {
    const result = await execFileAsync("rg", args, {
      cwd: WORKSPACE,
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    const errorRecord = toRecord(error);
    const errorCode = errorRecord.code;
    if (errorCode === 1) {
      const errorStdout = getStringProperty(errorRecord, "stdout");
      stdout = errorStdout ?? "";
    } else if (errorCode === "ENOENT") {
      const matches = await grepWithFallback(searchRootPath, parsedInput);
      return grepOutputSchema.parse({
        query: parsedInput.query,
        path: relativeSearchRootPath,
        matches,
        totalMatches: matches.length,
        truncated: matches.length >= parsedInput.maxResults,
      });
    } else {
      throw new Error(getStringProperty(errorRecord, "message") ?? "Failed to execute grep.");
    }
  }

  const matches = parseRgMatches(stdout, parsedInput.maxResults);

  return grepOutputSchema.parse({
    query: parsedInput.query,
    path: relativeSearchRootPath,
    matches,
    totalMatches: matches.length,
    truncated: matches.length >= parsedInput.maxResults,
  });
}
