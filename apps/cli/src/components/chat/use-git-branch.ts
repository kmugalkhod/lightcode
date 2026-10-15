import { promises as fs } from "node:fs";
import path from "node:path";
import { useEffect, useState } from "react";

const maximumParentDepth = 32;

async function readSmallFile(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.length > 4_096 ? null : content;
  } catch {
    return null;
  }
}

/**
 * Reads the checked-out branch straight from `.git/HEAD` (following a
 * worktree's `gitdir:` file) so the chat header can show it without
 * spawning git. Returns a short SHA for a detached HEAD, null outside a repo.
 */
export async function readGitBranch(cwd: string): Promise<string | null> {
  let directory = path.resolve(cwd);
  for (let depth = 0; depth < maximumParentDepth; depth += 1) {
    const dotGit = path.join(directory, ".git");
    const stats = await fs.stat(dotGit).catch(() => null);
    if (stats) {
      let gitDirectory = dotGit;
      if (stats.isFile()) {
        const pointer = (await readSmallFile(dotGit))?.match(/^gitdir:\s*(.+)\s*$/m);
        if (!pointer?.[1]) return null;
        gitDirectory = path.resolve(directory, pointer[1].trim());
      }
      const head = (await readSmallFile(path.join(gitDirectory, "HEAD")))?.trim();
      if (!head) return null;
      const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
      if (ref?.[1]) return ref[1];
      return /^[0-9a-f]{7,64}$/i.test(head) ? head.slice(0, 7) : null;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
}

/** Re-reads whenever `cwd` or `refreshKey` changes (e.g. after each run). */
export function useGitBranch(cwd: string, refreshKey: unknown): string | null {
  const [branch, setBranch] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void readGitBranch(cwd).then((next) => {
      if (alive) setBranch(next);
    });
    return () => {
      alive = false;
    };
  }, [cwd, refreshKey]);

  return branch;
}
