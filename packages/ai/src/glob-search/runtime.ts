import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  getDefaultWorkspaceContext,
  resolveWithinWorkspace,
  toWorkspaceRelativePath,
  type WorkspaceContext,
} from "../common/resolve-within-workspace";
import { globSearchInputSchema, globSearchOutputSchema } from "./schema";

type GlobSearchInput = z.input<typeof globSearchInputSchema>;
type GlobSearchOutput = z.infer<typeof globSearchOutputSchema>;
type GlobSearchMatch = GlobSearchOutput["matches"][number];

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

function normalizeGlobPath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function escapeRegExpCharacter(character: string) {
  return /[\\^$+?.()|[\]{}]/.test(character) ? `\\${character}` : character;
}

function globToRegExp(pattern: string) {
  const normalizedPattern = normalizeGlobPath(pattern);
  let source = "";

  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index];
    const nextCharacter = normalizedPattern[index + 1];

    if (character === "*") {
      if (nextCharacter === "*") {
        const afterGlobstar = normalizedPattern[index + 2];
        if (afterGlobstar === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
        continue;
      }

      source += "[^/]*";
      continue;
    }

    if (character === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegExpCharacter(character);
  }

  return new RegExp(`^${source}$`);
}

function isHiddenPath(relativePath: string) {
  return normalizeGlobPath(relativePath)
    .split("/")
    .some((segment) => segment.startsWith(".") && segment.length > 1);
}

function shouldSkipDirectory(name: string, includeHidden: boolean) {
  if (ignoredDirectoryNames.has(name)) {
    return true;
  }

  return !includeHidden && name.startsWith(".");
}

function entryTypeFromStats(stats: {
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
}): GlobSearchMatch["type"] {
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

async function collectEntry(
  absolutePath: string,
  searchRoot: string,
  parsedInput: z.infer<typeof globSearchInputSchema>,
  matcher: RegExp,
  workspaceContext: WorkspaceContext,
): Promise<GlobSearchMatch | null> {
  const relativeToSearchRoot = normalizeGlobPath(
    path.relative(searchRoot, absolutePath),
  );
  const comparablePath = relativeToSearchRoot === "" ? "." : relativeToSearchRoot;

  if (!parsedInput.includeHidden && isHiddenPath(comparablePath)) {
    return null;
  }

  if (!matcher.test(comparablePath)) {
    return null;
  }

  const entryStats = await lstat(absolutePath);
  const entryType = entryTypeFromStats(entryStats);

  if (entryType === "directory" && !parsedInput.includeDirectories) {
    return null;
  }

  return {
    path: toWorkspaceRelativePath(absolutePath, workspaceContext),
    type: entryType,
    size: entryType === "file" ? entryStats.size : null,
  };
}

export async function executeGlobSearch(
  input: GlobSearchInput,
  workspaceContext: WorkspaceContext = getDefaultWorkspaceContext(),
): Promise<GlobSearchOutput> {
  const parsedInput = globSearchInputSchema.parse(input);
  const searchRoot = resolveWithinWorkspace(parsedInput.path, {
    context: workspaceContext,
  });
  const searchRootStats = await stat(searchRoot);
  const relativeSearchRoot = toWorkspaceRelativePath(searchRoot, workspaceContext);
  const matcher = globToRegExp(parsedInput.pattern);
  const matches: GlobSearchMatch[] = [];
  let truncated = false;

  if (searchRootStats.isFile()) {
    const match = await collectEntry(
      searchRoot,
      path.dirname(searchRoot),
      parsedInput,
      matcher,
      workspaceContext,
    );

    if (match) {
      matches.push(match);
    }

    return globSearchOutputSchema.parse({
      pattern: parsedInput.pattern,
      path: relativeSearchRoot,
      matches,
      totalMatches: matches.length,
      truncated: false,
    });
  }

  const queue = [searchRoot];

  while (queue.length > 0 && matches.length < parsedInput.maxResults) {
    const currentDirectory = queue.shift()!;
    const directoryEntries = await readdir(currentDirectory, { withFileTypes: true });
    directoryEntries.sort((left, right) => left.name.localeCompare(right.name));

    for (const directoryEntry of directoryEntries) {
      if (directoryEntry.isDirectory() && shouldSkipDirectory(directoryEntry.name, parsedInput.includeHidden)) {
        continue;
      }

      const absoluteEntryPath = path.join(currentDirectory, directoryEntry.name);
      const match = await collectEntry(
        absoluteEntryPath,
        searchRoot,
        parsedInput,
        matcher,
        workspaceContext,
      );

      if (match) {
        matches.push(match);
      }

      if (directoryEntry.isDirectory()) {
        queue.push(absoluteEntryPath);
      }

      if (matches.length >= parsedInput.maxResults) {
        truncated = true;
        break;
      }
    }
  }

  return globSearchOutputSchema.parse({
    pattern: parsedInput.pattern,
    path: relativeSearchRoot,
    matches,
    totalMatches: matches.length,
    truncated,
  });
}
