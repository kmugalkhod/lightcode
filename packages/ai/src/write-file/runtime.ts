import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  getDefaultWorkspaceContext,
  resolveWithinWorkspace,
  toWorkspaceRelativePath,
  type WorkspaceContext,
} from "../common/resolve-within-workspace";
import { writeFileInputSchema, writeFileOutputSchema } from "./schema";

type WriteFileInput = z.input<typeof writeFileInputSchema>;
type WriteFileOutput = z.infer<typeof writeFileOutputSchema>;

export async function executeWriteFile(
  input: WriteFileInput,
  workspaceContext: WorkspaceContext = getDefaultWorkspaceContext(),
): Promise<WriteFileOutput> {
  const parsedInput = writeFileInputSchema.parse(input);
  const resolvedPath = resolveWithinWorkspace(parsedInput.path, {
    context: workspaceContext,
    allowMissing: true,
  });
  const relativePath = toWorkspaceRelativePath(resolvedPath, workspaceContext);

  let existingStats: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try {
    existingStats = await fs.stat(resolvedPath);
  } catch {
    existingStats = null;
  }

  if (existingStats?.isDirectory()) {
    throw new Error(`Path "${parsedInput.path}" is a directory and cannot be written as a file.`);
  }

  if (existingStats && !parsedInput.overwrite) {
    throw new Error(`Path "${parsedInput.path}" already exists and overwrite is disabled.`);
  }

  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

  await fs.writeFile(resolvedPath, parsedInput.content, "utf8");
  const bytesWritten = Buffer.byteLength(parsedInput.content, "utf8");

  return writeFileOutputSchema.parse({
    path: relativePath,
    created: existingStats == null,
    bytesWritten,
  });
}
