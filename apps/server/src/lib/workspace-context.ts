import {
  createWorkspaceContext,
  executeGitStatus,
  listSkills,
  type SkillSummary,
} from "@lightcode/ai/runtime";
import {
  fileReferenceUIPartSchema,
  getToolNameFromPart,
  isRecord,
} from "@lightcode/ai";
import {
  createLogger,
  getErrorMessage,
  getLightcodeDataDir,
} from "@lightcode/shared";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { platform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { UIMessage } from "ai";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const logger = createLogger("workspace-context");

/** Project instruction files in precedence order. Only the first match wins. */
const projectInstructionNames = ["AGENTS.md", "CLAUDE.md"] as const;

const maxListedEntries = 40;
const maxInstructionChars = 6_000;
const maxNestedInstructionChars = 6_000;
const maxNestedInstructionFileChars = 1_600;
const maxRepositoryMapChars = 6_000;
const maxRepositoryMapChildren = 32;
const maxBlockChars = 24_000;
const repositoryFileListTimeoutMs = 5_000;

const instructionEpochSchema = z.object({
  epoch: z.number().int().positive(),
  source: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.string(),
  discoveredAt: z.string().min(1),
});
const instructionEpochStateSchema = z.object({
  epochs: z.array(instructionEpochSchema),
});
type InstructionEpoch = z.infer<typeof instructionEpochSchema>;

export interface NestedWorkspaceInstructionOptions {
  cwd: string;
  sessionId?: string;
  relatedPaths?: readonly string[];
  /** Test seam; production state lives below Lightcode's user data directory. */
  dataDir?: string;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sessionStatePath({
  directory,
  sessionId,
  dataDir,
}: {
  directory: "instruction-epochs" | "session-environment";
  sessionId: string;
  dataDir?: string;
}): string {
  const sessionKey = createHash("sha256").update(sessionId).digest("hex");
  return path.join(
    dataDir ?? getLightcodeDataDir(),
    directory,
    `${sessionKey}.json`,
  );
}

function instructionEpochStatePath(options: {
  sessionId: string;
  dataDir?: string;
}): string {
  return sessionStatePath({ directory: "instruction-epochs", ...options });
}

async function loadInstructionEpochs(statePath: string): Promise<InstructionEpoch[]> {
  try {
    const parsed = instructionEpochStateSchema.safeParse(
      JSON.parse(await readFile(statePath, "utf8")),
    );
    if (parsed.success) {
      return parsed.data.epochs;
    }
    logger.warn("workspace_instruction_epochs_invalid", { statePath });
  } catch (error) {
    const code = isRecord(error) ? Reflect.get(error, "code") : undefined;
    if (code !== "ENOENT") {
      logger.warn("workspace_instruction_epochs_load_failed", {
        statePath,
        error: getErrorMessage(error),
      });
    }
  }
  return [];
}

async function persistInstructionEpochs(
  statePath: string,
  epochs: readonly InstructionEpoch[],
): Promise<void> {
  await writePrivateJsonFile(statePath, { epochs });
}

/** Atomic owner-only JSON write for session-local state files. */
async function writePrivateJsonFile(
  statePath: string,
  value: unknown,
): Promise<void> {
  const directory = path.dirname(statePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await rename(temporaryPath, statePath);
    await chmod(statePath, 0o600).catch(() => undefined);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function nearestExistingDirectory(candidate: string): Promise<string | null> {
  let current = candidate;
  while (true) {
    try {
      const metadata = await stat(current);
      return metadata.isDirectory() ? current : path.dirname(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }
}

async function discoverNestedInstructions({
  cwd,
  relatedPaths,
}: {
  cwd: string;
  relatedPaths: readonly string[];
}): Promise<Array<{ source: string; sha256: string; content: string }>> {
  let root: string;
  try {
    root = await realpath(cwd);
  } catch {
    return [];
  }

  const directories: string[] = [];
  const seenDirectories = new Set<string>();
  for (const relatedPath of relatedPaths) {
    if (!relatedPath.trim()) {
      continue;
    }
    const lexicalTarget = path.isAbsolute(relatedPath)
      ? path.normalize(relatedPath)
      : path.resolve(root, relatedPath);
    if (!isContainedPath(root, lexicalTarget)) {
      continue;
    }
    const existingDirectory = await nearestExistingDirectory(lexicalTarget);
    if (!existingDirectory) {
      continue;
    }
    let canonicalDirectory: string;
    try {
      canonicalDirectory = await realpath(existingDirectory);
    } catch {
      continue;
    }
    // A lexically safe path may cross a symlink out of the workspace.
    if (!isContainedPath(root, canonicalDirectory)) {
      continue;
    }

    const lineage: string[] = [];
    let current = canonicalDirectory;
    while (current !== root && isContainedPath(root, current)) {
      lineage.push(current);
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    lineage.reverse();
    for (const directory of lineage) {
      if (!seenDirectories.has(directory)) {
        seenDirectories.add(directory);
        directories.push(directory);
      }
    }
  }

  const discovered: Array<{ source: string; sha256: string; content: string }> = [];
  for (const directory of directories) {
    for (const name of projectInstructionNames) {
      const instructionPath = path.join(directory, name);
      try {
        const canonicalInstructionPath = await realpath(instructionPath);
        if (
          !isContainedPath(root, canonicalInstructionPath) ||
          path.dirname(canonicalInstructionPath) === root
        ) {
          continue;
        }
        const rawContent = await readFile(canonicalInstructionPath, "utf8");
        const trimmed = rawContent.trim();
        if (!trimmed) {
          continue;
        }
        const content =
          trimmed.length > maxNestedInstructionFileChars
            ? `${trimmed.slice(0, maxNestedInstructionFileChars)}\n… (nested instructions truncated; use read_file for the complete source)`
            : trimmed;
        discovered.push({
          source: path.relative(root, canonicalInstructionPath).split(path.sep).join("/"),
          sha256: createHash("sha256").update(rawContent).digest("hex"),
          content,
        });
        break;
      } catch {
        // This directory has no readable instruction file with this name.
      }
    }
  }
  return discovered;
}

/**
 * Finds path-bearing UI parts in chronological order. File references are
 * typed and hash-backed; tool inputs contribute only their explicit `path`.
 */
export function collectRelatedWorkspacePaths(
  messages: readonly UIMessage[],
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: unknown) => {
    if (typeof candidate !== "string" || !candidate.trim() || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    paths.push(candidate);
  };

  for (const message of messages) {
    for (const part of message.parts) {
      const fileReference = fileReferenceUIPartSchema.safeParse(part);
      if (fileReference.success) {
        add(fileReference.data.data.path);
        continue;
      }
      if (!getToolNameFromPart(part) || !isRecord(part)) {
        continue;
      }
      const input = Reflect.get(part, "input");
      if (isRecord(input)) {
        add(Reflect.get(input, "path"));
      }
    }
  }
  return paths;
}

/**
 * Lazily loads nested AGENTS.md/CLAUDE.md files only for paths referenced by
 * the conversation. Changes are appended to a session-local epoch log while
 * the provider-facing rendering remains globally bounded.
 */
export async function buildNestedWorkspaceInstructionBlock({
  cwd,
  sessionId,
  relatedPaths = [],
  dataDir,
}: NestedWorkspaceInstructionOptions): Promise<string> {
  if (relatedPaths.length === 0) {
    return "";
  }
  const discovered = await discoverNestedInstructions({ cwd, relatedPaths });
  if (discovered.length === 0) {
    return "";
  }

  const statePath = sessionId
    ? instructionEpochStatePath({ sessionId, dataDir })
    : null;
  const epochs = statePath ? await loadInstructionEpochs(statePath) : [];
  let changed = false;
  for (const instruction of discovered) {
    const latest = epochs.findLast((epoch) => epoch.source === instruction.source);
    if (latest?.sha256 === instruction.sha256) {
      continue;
    }
    epochs.push({
      epoch: (epochs.at(-1)?.epoch ?? 0) + 1,
      ...instruction,
      discoveredAt: new Date().toISOString(),
    });
    changed = true;
  }
  if (statePath && changed) {
    try {
      await persistInstructionEpochs(statePath, epochs);
    } catch (error) {
      logger.warn("workspace_instruction_epochs_persist_failed", {
        statePath,
        error: getErrorMessage(error),
      });
    }
  }

  const latestEpochBySource = new Map<string, number>();
  for (const epoch of epochs) {
    latestEpochBySource.set(epoch.source, epoch.epoch);
  }
  const opening = "<nested-workspace-instruction-epochs>";
  const closing = "</nested-workspace-instruction-epochs>";
  const blocks = epochs.map((epoch) => {
    const superseded = latestEpochBySource.get(epoch.source) !== epoch.epoch;
    const attributes = `epoch="${epoch.epoch}" source="${escapeAttribute(epoch.source)}" sha256="${epoch.sha256}" superseded="${superseded}"`;
    // Old bodies remain complete in the local epoch log. Provider context only
    // needs their chronology; replaying obsolete rules wastes tokens and can
    // contradict the current epoch.
    return superseded
      ? `<instruction-epoch ${attributes} />`
      : [
          `<instruction-epoch ${attributes}>`,
          epoch.content,
          "</instruction-epoch>",
        ].join("\n");
  });
  const selected: string[] = [];
  let used = opening.length + closing.length + 2;
  let omitted = false;
  // Prefer the newest/current rules if the bounded block cannot carry every
  // historical epoch, then restore chronological order for rendering.
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index] ?? "";
    if (used + block.length + 1 > maxNestedInstructionChars) {
      omitted = true;
      continue;
    }
    selected.unshift(block);
    used += block.length + 1;
  }
  const rendered: string[] = [opening];
  if (omitted) {
    rendered.push("… (older or larger nested instruction epochs omitted)");
  }
  rendered.push(...selected);
  rendered.push(closing);
  return rendered.join("\n");
}

/**
 * Render the discoverable skills as a compact list the agent can act on. Pure
 * (no fs) so it is unit-testable; returns "" when there are no skills.
 */
export function formatAvailableSkills(skills: readonly SkillSummary[]): string {
  if (skills.length === 0) {
    return "";
  }

  const shown = skills;
  const lines = shown.map(
    (skill) =>
      `- ${skill.name}${skill.description ? `: ${skill.description.replace(/\s+/g, " ").slice(0, 300)}` : ""}`,
  );
  return `Available skills (load by name with the skill tool):\n${lines.join("\n")}`;
}

function buildAvailableSkills(cwd: string): string {
  try {
    return formatAvailableSkills(listSkills({ cwd }));
  } catch (error) {
    logger.warn("workspace_skills_failed", { cwd, error: getErrorMessage(error) });
    return "";
  }
}

function describePlatform(): string {
  const map: Record<string, string> = {
    darwin: "macOS",
    win32: "Windows",
    linux: "Linux",
  };
  return map[platform()] ?? platform();
}

async function buildDirectoryListing(cwd: string): Promise<string> {
  try {
    const dirents = await readdir(cwd, { withFileTypes: true });
    const names = dirents
      .filter((entry) => entry.name !== ".git")
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((a, b) => a.localeCompare(b));

    const shown = names.slice(0, maxListedEntries);
    const suffix =
      names.length > shown.length
        ? `\n… and ${names.length - shown.length} more`
        : "";
    return shown.length > 0 ? shown.join("\n") + suffix : "(empty directory)";
  } catch (error) {
    logger.warn("workspace_listing_failed", { cwd, error: getErrorMessage(error) });
    return "(unable to list directory)";
  }
}

/**
 * Tracked plus untracked-but-not-ignored files, relative to `cwd`. Null when
 * `cwd` is not inside a git work tree (or git is unavailable).
 */
async function listRepositoryFiles(cwd: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: repositoryFileListTimeoutMs,
        windowsHide: true,
      },
    );
    return [...new Set(stdout.split("\0").filter(Boolean))];
  } catch {
    return null;
  }
}

interface RepositoryTreeNode {
  directories: Map<string, RepositoryTreeNode>;
  files: string[];
  /** Files anywhere below this directory. */
  fileCount: number;
}

function createRepositoryTreeNode(): RepositoryTreeNode {
  return { directories: new Map(), files: [], fileCount: 0 };
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A folder's subfolders, capped so one huge folder cannot crowd out the map. */
function visibleSubdirectories(node: RepositoryTreeNode): {
  shown: Array<{ name: string; node: RepositoryTreeNode }>;
  hiddenCount: number;
} {
  const all = [...node.directories.entries()]
    .sort(([left], [right]) => compareNames(left, right))
    .map(([name, child]) => ({ name, node: child }));
  return {
    shown: all.slice(0, maxRepositoryMapChildren),
    hiddenCount: Math.max(0, all.length - maxRepositoryMapChildren),
  };
}

function subdirectoryLines(node: RepositoryTreeNode, depth: number): string[] {
  const indent = "  ".repeat(depth);
  const { shown, hiddenCount } = visibleSubdirectories(node);
  const lines = shown.map(
    ({ name, node: child }) => `${indent}${name}/ (${child.fileCount})`,
  );
  if (hiddenCount > 0) {
    lines.push(`${indent}… ${hiddenCount} more folders`);
  }
  return lines;
}

function fileNameLines(node: RepositoryTreeNode, depth: number): string[] {
  const indent = "  ".repeat(depth);
  const files = [...node.files].sort(compareNames);
  const lines = files
    .slice(0, maxRepositoryMapChildren)
    .map((name) => `${indent}${name}`);
  if (files.length > lines.length) {
    lines.push(`${indent}… ${files.length - lines.length} more files`);
  }
  return lines;
}

/** Stands in for a folder's file names until (unless) the budget allows them. */
function filePlaceholderLines(node: RepositoryTreeNode, depth: number): string[] {
  return node.files.length > 0
    ? [`${"  ".repeat(depth)}… ${node.files.length} files`]
    : [];
}

function linesCost(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0);
}

/**
 * Renders a compact, deterministic file tree within `maxChars`, saving the
 * agent the list_files/glob round trips it would otherwise spend orienting.
 * Pass one lays out the folder skeleton breadth-first, as deep as the budget
 * allows — folder names carry most of the navigation value. Pass two swaps in
 * file names, shallow folders first. A folder that does not fit stays a single
 * `name/ (N)` line.
 */
export function formatRepositoryMap(
  paths: readonly string[],
  maxChars = maxRepositoryMapChars,
): string {
  const root = createRepositoryTreeNode();
  for (const filePath of paths) {
    const segments = filePath.split("/").filter(Boolean);
    const fileName = segments.pop();
    if (!fileName) {
      continue;
    }
    let current = root;
    current.fileCount += 1;
    for (const segment of segments) {
      let child = current.directories.get(segment);
      if (!child) {
        child = createRepositoryTreeNode();
        current.directories.set(segment, child);
      }
      child.fileCount += 1;
      current = child;
    }
    current.files.push(fileName);
  }

  if (root.fileCount === 0) {
    return "(no files)";
  }

  const order: Array<{ node: RepositoryTreeNode; depth: number }> = [
    { node: root, depth: 0 },
  ];
  const expanded = new Set<RepositoryTreeNode>();
  let used = 0;
  for (let index = 0; index < order.length; index += 1) {
    const { node, depth } = order[index]!;
    const cost =
      linesCost(subdirectoryLines(node, depth)) +
      linesCost(filePlaceholderLines(node, depth));
    // The root always renders; deeper folders stay collapsed when over budget.
    if (node !== root && used + cost > maxChars) {
      continue;
    }
    used += cost;
    expanded.add(node);
    for (const { name, node: child } of visibleSubdirectories(node).shown) {
      // Dot-folders (.github, .agents, .vscode) are tooling config: listed,
      // never expanded, so the budget goes to source directories.
      if (!name.startsWith(".")) {
        order.push({ node: child, depth: depth + 1 });
      }
    }
  }

  // Root files (manifests, READMEs) first, then the smallest folders: naming
  // many small folders completely beats half-listing one huge one. The sort is
  // stable, so equal sizes keep breadth-first order.
  const fileCandidates = order
    .filter(({ node }) => expanded.has(node) && node.files.length > 0)
    .sort((left, right) =>
      left.node === root
        ? -1
        : right.node === root
          ? 1
          : left.node.files.length - right.node.files.length,
    );
  const filesShown = new Set<RepositoryTreeNode>();
  for (const { node, depth } of fileCandidates) {
    const delta =
      linesCost(fileNameLines(node, depth)) -
      linesCost(filePlaceholderLines(node, depth));
    if (used + delta > maxChars) {
      continue;
    }
    used += delta;
    filesShown.add(node);
  }

  const lines: string[] = [];
  const render = (node: RepositoryTreeNode, depth: number) => {
    const { shown } = visibleSubdirectories(node);
    subdirectoryLines(node, depth).forEach((line, index) => {
      lines.push(line);
      const child = shown[index]?.node;
      if (child && expanded.has(child)) {
        render(child, depth + 1);
      }
    });
    lines.push(
      ...(filesShown.has(node)
        ? fileNameLines(node, depth)
        : filePlaceholderLines(node, depth)),
    );
  };
  render(root, 0);
  return lines.join("\n");
}

async function buildRepositoryOverview(cwd: string): Promise<string> {
  const files = await listRepositoryFiles(cwd);
  if (!files) {
    return ["Top-level entries:", await buildDirectoryListing(cwd)].join("\n");
  }
  return [
    `Repository files (${files.length}; dir/ (N) = N files inside, "…" = more not shown; use glob_search or list_files for the rest):`,
    formatRepositoryMap(files),
  ].join("\n");
}

// The git summary spawns a `git status` subprocess for every session snapshot
// (and every session-less build). A short TTL makes bursts — several sessions
// or subagents starting together — reuse it while staying fresh.
const gitSummaryCacheTtlMs = 5_000;
const gitSummaryCache = new Map<
  string,
  { expiresAt: number; summary: Promise<string> }
>();

function buildGitSummary(cwd: string): Promise<string> {
  const cached = gitSummaryCache.get(cwd);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.summary;
  }

  const summary = buildGitSummaryUncached(cwd);
  gitSummaryCache.set(cwd, {
    expiresAt: Date.now() + gitSummaryCacheTtlMs,
    summary,
  });
  return summary;
}

async function buildGitSummaryUncached(cwd: string): Promise<string> {
  try {
    const context = createWorkspaceContext(cwd);
    const status = await executeGitStatus({}, context);
    if (!status.ok) {
      return "Not a git repository.";
    }

    const header = [
      `branch: ${status.branch ?? "(detached)"}`,
      status.ahead || status.behind
        ? `ahead ${status.ahead}, behind ${status.behind}`
        : null,
    ]
      .filter(Boolean)
      .join(" | ");

    if (status.totalEntries === 0) {
      return `${header}\nworking tree clean`;
    }

    const lines = status.entries
      .slice(0, maxListedEntries)
      .map(
        (entry) =>
          `${entry.indexStatus}${entry.workingTreeStatus} ${entry.path}`.trim(),
      );
    const more =
      status.totalEntries > lines.length
        ? `\n… and ${status.totalEntries - lines.length} more`
        : "";
    return `${header}\nchanges:\n${lines.join("\n")}${more}`;
  } catch (error) {
    // createWorkspaceContext throws for non-directories / unreadable paths.
    logger.warn("workspace_git_summary_failed", { cwd, error: getErrorMessage(error) });
    return "Not a git repository.";
  }
}

export interface WorkspaceInstructionBaseline {
  source: "AGENTS.md" | "CLAUDE.md" | null;
  sha256: string;
  content: string;
  block: string;
}

/**
 * Loads the authoritative root instruction baseline. AGENTS.md wins; CLAUDE.md
 * is a compatibility fallback, and README is intentionally ordinary project
 * content rather than privileged model instructions. The hash covers the full
 * source even when the provider-facing body is bounded.
 */
export async function buildWorkspaceInstructionBaseline({
  cwd,
}: {
  cwd: string;
}): Promise<WorkspaceInstructionBaseline> {
  for (const name of projectInstructionNames) {
    try {
      const rawContent = await readFile(path.join(cwd, name), "utf8");
      const content = rawContent.trim();
      if (!content) {
        continue;
      }
      const sha256 = createHash("sha256").update(rawContent).digest("hex");
      const bounded =
        content.length > maxInstructionChars
          ? `${content.slice(0, maxInstructionChars)}\n… (instructions truncated; use read_file for the complete source)`
          : content;
      return {
        source: name,
        sha256,
        content: bounded,
        block: [
          `<workspace-instructions source="${name}" sha256="${sha256}">`,
          bounded,
          "</workspace-instructions>",
        ].join("\n"),
      };
    } catch {
      // File absent or unreadable — skip silently.
    }
  }

  const content = "(No root AGENTS.md or CLAUDE.md instructions found.)";
  const sha256 = createHash("sha256").update(content).digest("hex");
  return {
    source: null,
    sha256,
    content,
    block: [
      `<workspace-instructions source="none" sha256="${sha256}">`,
      content,
      "</workspace-instructions>",
    ].join("\n"),
  };
}

const environmentSnapshotSchema = z.object({
  cwd: z.string().min(1),
  capturedAt: z.string().min(1),
  body: z.string(),
});
type EnvironmentSnapshot = z.infer<typeof environmentSnapshotSchema>;

// Keeps a session's snapshot stable for this process even when the disk write
// failed; bounded so long-lived servers do not accumulate every session.
const maxMemoizedEnvironmentSnapshots = 256;
const environmentSnapshotMemo = new Map<string, EnvironmentSnapshot>();

function memoizeEnvironmentSnapshot(
  statePath: string,
  snapshot: EnvironmentSnapshot,
): EnvironmentSnapshot {
  environmentSnapshotMemo.delete(statePath);
  environmentSnapshotMemo.set(statePath, snapshot);
  if (environmentSnapshotMemo.size > maxMemoizedEnvironmentSnapshots) {
    const oldest = environmentSnapshotMemo.keys().next().value;
    if (oldest !== undefined) {
      environmentSnapshotMemo.delete(oldest);
    }
  }
  return snapshot;
}

/** Test helper: forget in-process snapshots, as a server restart would. */
export function resetEnvironmentSnapshotMemo(): void {
  environmentSnapshotMemo.clear();
}

async function captureEnvironmentSnapshot(
  cwd: string,
): Promise<EnvironmentSnapshot> {
  const [overview, git] = await Promise.all([
    buildRepositoryOverview(cwd),
    buildGitSummary(cwd),
  ]);
  const capturedAt = new Date().toISOString();
  return {
    cwd,
    capturedAt,
    body: [
      `Working directory: ${cwd}`,
      `Platform: ${describePlatform()}`,
      `Date: ${capturedAt.slice(0, 10)} (session start)`,
      "",
      "Git (snapshot from session start; call git_status for the current state):",
      git,
      "",
      overview,
    ].join("\n"),
  };
}

async function loadEnvironmentSnapshot(
  statePath: string,
  cwd: string,
): Promise<EnvironmentSnapshot | null> {
  const memoized = environmentSnapshotMemo.get(statePath);
  if (memoized?.cwd === cwd) {
    return memoized;
  }

  try {
    const parsed = environmentSnapshotSchema.safeParse(
      JSON.parse(await readFile(statePath, "utf8")),
    );
    if (parsed.success && parsed.data.cwd === cwd) {
      return memoizeEnvironmentSnapshot(statePath, parsed.data);
    }
    if (!parsed.success) {
      logger.warn("workspace_environment_snapshot_invalid", { statePath });
    }
  } catch (error) {
    const code = isRecord(error) ? Reflect.get(error, "code") : undefined;
    if (code !== "ENOENT") {
      logger.warn("workspace_environment_snapshot_load_failed", {
        statePath,
        error: getErrorMessage(error),
      });
    }
  }
  return null;
}

/**
 * The volatile half of the environment (git state, listing, date) is captured
 * once per session and replayed verbatim. It sits in the system prompt, ahead
 * of the whole conversation, so refreshing it every turn would invalidate the
 * provider's cached prefix for the entire history on every request.
 */
async function resolveEnvironmentSnapshot({
  cwd,
  sessionId,
  dataDir,
}: {
  cwd: string;
  sessionId?: string;
  dataDir?: string;
}): Promise<EnvironmentSnapshot> {
  if (!sessionId) {
    return captureEnvironmentSnapshot(cwd);
  }

  const statePath = sessionStatePath({
    directory: "session-environment",
    sessionId,
    dataDir,
  });
  const existing = await loadEnvironmentSnapshot(statePath, cwd);
  if (existing) {
    return existing;
  }

  const snapshot = memoizeEnvironmentSnapshot(
    statePath,
    await captureEnvironmentSnapshot(cwd),
  );
  try {
    await writePrivateJsonFile(statePath, snapshot);
  } catch (error) {
    logger.warn("workspace_environment_snapshot_persist_failed", {
      statePath,
      error: getErrorMessage(error),
    });
  }
  return snapshot;
}

/**
 * Builds the workspace block appended to the system prompt: the root
 * instruction baseline, lazily discovered nested instructions, and an
 * `<environment>` section, so the agent knows the repo it is operating on and
 * reads files from it instead of asking the user to paste code.
 *
 * Byte-stable across turns of a session unless instruction or skill files
 * change. Best-effort and bounded in size; never throws.
 */
export async function buildWorkspaceContext({
  cwd,
  sessionId,
  relatedPaths,
  dataDir,
}: NestedWorkspaceInstructionOptions): Promise<string> {
  const [baseline, nestedInstructions, snapshot] = await Promise.all([
    buildWorkspaceInstructionBaseline({ cwd }),
    buildNestedWorkspaceInstructionBlock({
      cwd,
      sessionId,
      relatedPaths,
      dataDir,
    }),
    resolveEnvironmentSnapshot({ cwd, sessionId, dataDir }),
  ]);
  const skills = buildAvailableSkills(cwd);

  const parts = [
    baseline.block,
    nestedInstructions ? `\n${nestedInstructions}` : "",
    "",
    "<environment>",
    snapshot.body,
    skills ? `\n${skills}` : "",
    "</environment>",
  ];

  const block = parts.join("\n");
  return block.length > maxBlockChars
    ? `${block.slice(0, maxBlockChars)}\n… (environment truncated)\n</environment>`
    : block;
}
