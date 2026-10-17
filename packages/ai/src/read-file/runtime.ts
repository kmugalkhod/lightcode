import { promises as fs } from "node:fs";
import { z } from "zod";
import { READ_FILE_OUTPUT_CHARS } from "../constants";
import {
  getDefaultWorkspaceContext,
  resolveWithinWorkspace,
  toWorkspaceRelativePath,
  type WorkspaceContext,
} from "../common/resolve-within-workspace";
import { truncateText } from "../common/output-utils";
import { readFileInputSchema, readFileOutputSchema } from "./schema";

type ReadFileInput = z.input<typeof readFileInputSchema>;
type ReadFileOutput = z.infer<typeof readFileOutputSchema>;

function clampLineRange(totalLines: number, startLine?: number, endLine?: number) {
  if (totalLines === 0) {
    return {
      start: 1,
      end: 1,
    };
  }

  const start = Math.min(Math.max(startLine ?? 1, 1), totalLines);
  const end = Math.min(Math.max(endLine ?? totalLines, start), totalLines);

  return { start, end };
}

export async function executeReadFile(
  input: ReadFileInput,
  workspaceContext: WorkspaceContext = getDefaultWorkspaceContext(),
): Promise<ReadFileOutput> {
  const parsedInput = readFileInputSchema.parse(input);
  const resolvedPath = resolveWithinWorkspace(parsedInput.path, {
    context: workspaceContext,
  });
  const relativePath = toWorkspaceRelativePath(resolvedPath, workspaceContext);
  const fileStats = await fs.stat(resolvedPath);

  if (!fileStats.isFile()) {
    throw new Error(`Path "${parsedInput.path}" is not a file.`);
  }

  const fileContent = await fs.readFile(resolvedPath, "utf8");
  const lines = fileContent.split(/\r?\n/);
  const { start, end } = clampLineRange(lines.length, parsedInput.startLine, parsedInput.endLine);
  const maxChars = parsedInput.maxChars ?? READ_FILE_OUTPUT_CHARS;
  const taken = takeWholeLines(lines.slice(start - 1, end), maxChars);
  const lastLine = start + taken.lineCount - 1;

  return readFileOutputSchema.parse({
    path: relativePath,
    startLine: start,
    endLine: lastLine,
    content: taken.text,
    totalLines: lines.length,
    truncated: taken.truncated,
    ...(lastLine < end ? { nextStartLine: lastLine + 1 } : {}),
  });
}

/**
 * Keeps whole lines within the budget, so a cut result ends at an exact line
 * the model can continue from — unlike a head+tail cut, which hides the
 * middle of the file behind a marker. Only a single line longer than the
 * whole budget (minified output) is cut within the line.
 */
function takeWholeLines(
  lines: readonly string[],
  maxChars: number,
): { text: string; lineCount: number; truncated: boolean } {
  let used = 0;
  let lineCount = 0;
  for (const line of lines) {
    const cost = line.length + (lineCount > 0 ? 1 : 0);
    if (used + cost > maxChars) {
      break;
    }
    used += cost;
    lineCount += 1;
  }

  if (lineCount === 0 && lines.length > 0) {
    return {
      text: truncateText(lines[0] ?? "", maxChars).text,
      lineCount: 1,
      truncated: true,
    };
  }

  return {
    text: lines.slice(0, lineCount).join("\n"),
    lineCount,
    truncated: lineCount < lines.length,
  };
}
