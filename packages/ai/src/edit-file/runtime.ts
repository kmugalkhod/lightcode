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
import { applyEdit } from "./match";
import { editFileInputSchema, editFileOutputSchema } from "./schema";

type EditFileInput = z.input<typeof editFileInputSchema>;
type EditFileOutput = z.infer<typeof editFileOutputSchema>;

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

  // Tolerant match: exact → line-ending-normalized → whitespace-flexible, with a
  // uniqueness guard and original-EOL preservation. Throws a descriptive error
  // on no/ambiguous match, which surfaces to the model as the tool result.
  const { updatedContent, replacements } = applyEdit(
    originalContent,
    parsedInput.search,
    parsedInput.replace,
    parsedInput.replaceAll,
  );

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
