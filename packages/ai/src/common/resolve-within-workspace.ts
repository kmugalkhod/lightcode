import path from "node:path";
import {
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";

export interface WorkspaceContext {
  root: string;
}

export interface ResolveWithinWorkspaceOptions {
  context?: WorkspaceContext;
  allowMissing?: boolean;
}

const nativeRealpathSync = realpathSync.native ?? realpathSync;

function stripTrailingSeparator(value: string): string {
  const parsed = path.parse(value);
  if (value === parsed.root) {
    return value;
  }

  return value.replace(/[\\/]+$/, "");
}

function normalizeForComparison(value: string): string {
  const normalized = stripTrailingSeparator(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithinWorkspace(absolutePath: string, context: WorkspaceContext): boolean {
  const workspace = normalizeForComparison(context.root);
  const target = normalizeForComparison(absolutePath);

  return target === workspace || target.startsWith(`${workspace}${path.sep}`);
}

function assertWithinWorkspace(
  absolutePath: string,
  context: WorkspaceContext,
  input: string,
) {
  if (!isWithinWorkspace(absolutePath, context)) {
    throw new Error(`Path escapes workspace: ${input}`);
  }
}

function getExistingRealPath(absolutePath: string): string | null {
  try {
    return nativeRealpathSync(absolutePath);
  } catch {
    return null;
  }
}

function findNearestExistingParent(
  absolutePath: string,
  context: WorkspaceContext,
  input: string,
): string {
  let currentPath = path.dirname(absolutePath);

  while (true) {
    assertWithinWorkspace(currentPath, context, input);

    if (existsSync(currentPath)) {
      const realParentPath = getExistingRealPath(currentPath);
      if (!realParentPath) {
        throw new Error(`Unable to resolve existing parent for path: ${input}`);
      }

      return realParentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(`Unable to find an existing workspace parent for path: ${input}`);
    }

    currentPath = parentPath;
  }
}

export function createWorkspaceContext(cwd = process.cwd()): WorkspaceContext {
  const root = nativeRealpathSync(cwd);
  const rootStats = statSync(root);

  if (!rootStats.isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${cwd}`);
  }

  return { root };
}

const defaultWorkspaceContext = createWorkspaceContext();

export const WORKSPACE = defaultWorkspaceContext.root;

export function getDefaultWorkspaceContext(): WorkspaceContext {
  return defaultWorkspaceContext;
}

export function resolveWithinWorkspace(
  input: string,
  options: ResolveWithinWorkspaceOptions = {},
): string {
  const context = options.context ?? defaultWorkspaceContext;
  const resolved = path.resolve(context.root, input);
  assertWithinWorkspace(resolved, context, input);

  const realPath = getExistingRealPath(resolved);
  if (realPath) {
    assertWithinWorkspace(realPath, context, input);
    return realPath;
  }

  if (!options.allowMissing) {
    throw new Error(`Path does not exist in workspace: ${input}`);
  }

  try {
    const candidateStats = lstatSync(resolved);
    if (candidateStats.isSymbolicLink()) {
      throw new Error(`Path is a broken symlink and cannot be resolved safely: ${input}`);
    }
  } catch (error) {
    if (error instanceof Error && !("code" in error)) {
      throw error;
    }
  }

  const realParentPath = findNearestExistingParent(resolved, context, input);
  assertWithinWorkspace(realParentPath, context, input);

  return resolved;
}

export function toWorkspaceRelativePath(
  absolutePath: string,
  context: WorkspaceContext = defaultWorkspaceContext,
): string {
  const resolved = path.resolve(absolutePath);
  assertWithinWorkspace(resolved, context, absolutePath);
  const relativePath = path.relative(context.root, resolved);

  if (relativePath === "") {
    return ".";
  }

  return relativePath.split(path.sep).join("/");
}
