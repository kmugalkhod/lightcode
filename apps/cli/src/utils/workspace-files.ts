import { readdir } from "node:fs/promises";
import path from "node:path";

// Mirrors the glob-search runtime's skip list; kept local because the tool
// schema caps results at 200, which starved the @-mention picker in any
// non-trivial repo.
const ignoredDirectoryNames = new Set([
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

/**
 * Breadth-first list of workspace file paths (relative, /-separated) for the
 * @-mention picker. BFS puts shallow files first, which reads better in an
 * empty-query dropdown than a depth-first dive into one subtree.
 */
export async function listWorkspaceFiles(
  root: string,
  limit = 3000,
): Promise<string[]> {
  const files: string[] = [];
  const queue = [root];

  while (queue.length > 0 && files.length < limit) {
    const directory = queue.shift()!;

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue; // Unreadable directory (permissions, races) — skip it.
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.name.startsWith(".") || ignoredDirectoryNames.has(entry.name)) {
        continue;
      }

      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
      } else if (entry.isFile()) {
        files.push(path.relative(root, absolutePath).replaceAll("\\", "/"));
        if (files.length >= limit) {
          break;
        }
      }
    }
  }

  return files;
}
