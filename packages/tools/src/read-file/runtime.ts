import { promises as fs } from "node:fs";
import { MAX_TOOL_TEXT_OUTPUT_CHARS } from "../constants";
import { resolveWithinWorkspace, toWorkspaceRelativePath } from "../common/resolve-within-workspace";
import { truncateText } from "../common/output-utils";
import { readFileInputSchema, readFileOutputSchema } from "./schema";

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

export async function executeReadFile(input: unknown) {
  const parsedInput = readFileInputSchema.parse(input);
  const resolvedPath = resolveWithinWorkspace(parsedInput.path);
  const relativePath = toWorkspaceRelativePath(resolvedPath);
  const fileStats = await fs.stat(resolvedPath);

  if (!fileStats.isFile()) {
    throw new Error(`Path "${parsedInput.path}" is not a file.`);
  }

  const fileContent = await fs.readFile(resolvedPath, "utf8");
  const lines = fileContent.split(/\r?\n/);
  const { start, end } = clampLineRange(lines.length, parsedInput.startLine, parsedInput.endLine);
  const selectedContent = lines.slice(start - 1, end).join("\n");
  const maxChars = parsedInput.maxChars ?? MAX_TOOL_TEXT_OUTPUT_CHARS;
  const truncated = truncateText(selectedContent, maxChars);

  return readFileOutputSchema.parse({
    path: relativePath,
    startLine: start,
    endLine: end,
    content: truncated.text,
    totalLines: lines.length,
    truncated: truncated.truncated,
  });
}
