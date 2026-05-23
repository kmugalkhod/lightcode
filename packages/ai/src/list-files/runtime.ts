import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { listFilesInputSchema, listFilesOutputSchema } from "./schema";
import { resolveWithinWorkspace, toWorkspaceRelativePath } from "../common/resolve-within-workspace";

type ListFilesInput = z.input<typeof listFilesInputSchema>;
type ListFilesOutput = z.infer<typeof listFilesOutputSchema>;
type ListFilesEntryType = ListFilesOutput["entries"][number]["type"];

function entryTypeFromStats(
  stats: {
    isFile: () => boolean;
    isDirectory: () => boolean;
    isSymbolicLink: () => boolean;
  },
): ListFilesEntryType {
  if (stats.isFile()) {
    return "file";
  }

  if (stats.isDirectory()) {
    return "directory";
  }

  if (stats.isSymbolicLink()) {
    return "symlink";
  }

  return "other";
}

export async function executeListFiles(input: ListFilesInput): Promise<ListFilesOutput> {
  const parsedInput = listFilesInputSchema.parse(input);
  const resolvedRoot = resolveWithinWorkspace(parsedInput.path);
  const relativeRootPath = toWorkspaceRelativePath(resolvedRoot);
  const rootStats = await fs.stat(resolvedRoot);

  const entries: Array<{ path: string; type: "file" | "directory" | "symlink" | "other"; size: number | null }> = [];
  let truncated = false;

  if (rootStats.isFile()) {
    entries.push({
      path: relativeRootPath,
      type: "file",
      size: rootStats.size,
    });

    return listFilesOutputSchema.parse({
      path: relativeRootPath,
      entries,
      totalEntries: entries.length,
      truncated: false,
    });
  }

  const queue: string[] = [resolvedRoot];
  const maxEntries = parsedInput.maxEntries;

  while (queue.length > 0 && entries.length < maxEntries) {
    const currentDirectoryPath = queue.shift()!;
    const dirEntries = await fs.readdir(currentDirectoryPath, { withFileTypes: true });
    dirEntries.sort((a, b) => a.name.localeCompare(b.name));

    for (const dirEntry of dirEntries) {
      const isHidden = dirEntry.name.startsWith(".");
      if (!parsedInput.includeHidden && isHidden) {
        continue;
      }

      const absoluteEntryPath = path.join(currentDirectoryPath, dirEntry.name);
      const relativeEntryPath = toWorkspaceRelativePath(absoluteEntryPath);

      const entryStats = await fs.lstat(absoluteEntryPath);
      const entryType = entryTypeFromStats(entryStats);
      const entrySize = entryType === "file" ? entryStats.size : null;

      entries.push({
        path: relativeEntryPath,
        type: entryType,
        size: entrySize,
      });

      if (parsedInput.recursive && entryType === "directory") {
        queue.push(absoluteEntryPath);
      }

      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
    }
  }

  return listFilesOutputSchema.parse({
    path: relativeRootPath,
    entries,
    totalEntries: entries.length,
    truncated,
  });
}
