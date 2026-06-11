import { promises as fs } from "node:fs";
import { z } from "zod";
import { recordFileCheckpoint } from "../checkpoints/runtime";
import {
  getDefaultWorkspaceContext,
  resolveWithinWorkspace,
  toWorkspaceRelativePath,
  type WorkspaceContext,
} from "../common/resolve-within-workspace";
import { createUnifiedDiff } from "../common/unified-diff";
import type { FileEditContext } from "../common/file-edit-context";
import { editFileInputSchema, editFileOutputSchema } from "./schema";

type EditFileInput = z.input<typeof editFileInputSchema>;
type EditFileOutput = z.infer<typeof editFileOutputSchema>;

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

export async function executeEditFile(
  input: EditFileInput,
  workspaceContext: WorkspaceContext = getDefaultWorkspaceContext(),
  editContext: FileEditContext = {},
): Promise<EditFileOutput> {
  const parsedInput = editFileInputSchema.parse(input);
  const resolvedPath = resolveWithinWorkspace(parsedInput.path, {
    context: workspaceContext,
  });
  const relativePath = toWorkspaceRelativePath(resolvedPath, workspaceContext);
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

  if (editContext.sessionId && editContext.turnKey) {
    await recordFileCheckpoint({
      sessionId: editContext.sessionId,
      turnKey: editContext.turnKey,
      absolutePath: resolvedPath,
      workspaceRelativePath: relativePath,
      previousContent: originalContent,
    });
  }

  await fs.writeFile(resolvedPath, updatedContent, "utf8");

  return editFileOutputSchema.parse({
    path: relativePath,
    replacements,
    bytesWritten: Buffer.byteLength(updatedContent, "utf8"),
    diff: createUnifiedDiff(relativePath, originalContent, updatedContent),
  });
}
