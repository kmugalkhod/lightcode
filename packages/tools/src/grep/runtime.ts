import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { resolveWithinWorkspace, toWorkspaceRelativePath, WORKSPACE } from "../common/resolve-within-workspace";
import { grepInputSchema, grepOutputSchema } from "./schema";

const execFileAsync = promisify(execFile);

interface RgJsonMatchEvent {
  type: "match";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    submatches: Array<{ start: number }>;
  };
}

function parseRgMatches(stdout: string, maxResults: number) {
  const matches: Array<{ path: string; lineNumber: number; column: number; line: string }> = [];
  const lines = stdout.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    const event = parsed as Partial<RgJsonMatchEvent>;
    if (event.type !== "match" || !event.data) {
      continue;
    }

    const rawPath = event.data.path?.text;
    if (!rawPath) {
      continue;
    }

    const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(WORKSPACE, rawPath);
    let relativePath: string;
    try {
      relativePath = toWorkspaceRelativePath(absolutePath);
    } catch {
      continue;
    }

    const column = (event.data.submatches?.[0]?.start ?? 0) + 1;
    matches.push({
      path: relativePath,
      lineNumber: event.data.line_number,
      column,
      line: (event.data.lines?.text ?? "").replace(/\r?\n$/, ""),
    });

    if (matches.length >= maxResults) {
      break;
    }
  }

  return matches;
}

export async function executeGrep(input: unknown) {
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
    const maybeError = error as { code?: string | number; stdout?: string; message?: string };
    if (maybeError.code === 1) {
      stdout = maybeError.stdout ?? "";
    } else if (maybeError.code === "ENOENT") {
      throw new Error("The 'rg' command is required for grep but is not available.");
    } else {
      throw new Error(maybeError.message ?? "Failed to execute grep.");
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
