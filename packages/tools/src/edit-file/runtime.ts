import { promises as fs } from "node:fs";
import { resolveWithinWorkspace, toWorkspaceRelativePath } from "../common/resolve-within-workspace";
import { editFileInputSchema, editFileOutputSchema } from "./schema";

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let startIndex = 0;

  while (true) {
    const index = haystack.indexOf(needle, startIndex);
    if (index === -1) {
      break;
    }

    count += 1;
    startIndex = index + needle.length;
  }

  return count;
}

export async function executeEditFile(input: unknown) {
  const parsedInput = editFileInputSchema.parse(input);
  const resolvedPath = resolveWithinWorkspace(parsedInput.path);
  const relativePath = toWorkspaceRelativePath(resolvedPath);
  const originalContent = await fs.readFile(resolvedPath, "utf8");

  const replacements = parsedInput.replaceAll
    ? countOccurrences(originalContent, parsedInput.search)
    : originalContent.includes(parsedInput.search)
      ? 1
      : 0;

  if (replacements === 0) {
    throw new Error(`No matches found for the provided search text in "${parsedInput.path}".`);
  }

  const updatedContent = parsedInput.replaceAll
    ? originalContent.split(parsedInput.search).join(parsedInput.replace)
    : originalContent.replace(parsedInput.search, parsedInput.replace);

  await fs.writeFile(resolvedPath, updatedContent, "utf8");

  return editFileOutputSchema.parse({
    path: relativePath,
    replacements,
    bytesWritten: Buffer.byteLength(updatedContent, "utf8"),
  });
}
