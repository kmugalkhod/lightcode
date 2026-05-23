import path from "node:path";
import { realpathSync } from "node:fs";

export const WORKSPACE = realpathSync(process.cwd());

function normalizeForComparison(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithinWorkspace(absolutePath: string): boolean {
  const workspace = normalizeForComparison(WORKSPACE);
  const target = normalizeForComparison(absolutePath);

  return target === workspace || target.startsWith(`${workspace}${path.sep}`);
}

export function resolveWithinWorkspace(input: string): string {
  const resolved = path.resolve(WORKSPACE, input);
  if (!isWithinWorkspace(resolved)) {
    throw new Error(`Path escapes workspace: ${input}`);
  }

  return resolved;
}

export function toWorkspaceRelativePath(absolutePath: string): string {
  const relativeInput = path.relative(WORKSPACE, absolutePath);
  const resolved = resolveWithinWorkspace(relativeInput);
  const relativePath = path.relative(WORKSPACE, resolved);

  if (relativePath === "") {
    return ".";
  }

  return relativePath.split(path.sep).join("/");
}
