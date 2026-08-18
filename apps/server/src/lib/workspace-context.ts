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
import type { UIMessage } from "ai";
import { z } from "zod";

const logger = createLogger("workspace-context");

/** Project instruction files in precedence order. Only the first match wins. */
const projectInstructionNames = ["AGENTS.md", "CLAUDE.md"] as const;

const maxListedEntries = 40;
const maxListedSkills = 20;
const maxInstructionChars = 6_000;
const maxNestedInstructionChars = 6_000;
const maxNestedInstructionFileChars = 1_600;
const maxBlockChars = 18_000;

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

function instructionEpochStatePath({
  sessionId,
  dataDir,
}: {
  sessionId: string;
  dataDir?: string;
}): string {
  const sessionKey = createHash("sha256").update(sessionId).digest("hex");
  return path.join(
    dataDir ?? getLightcodeDataDir(),
    "instruction-epochs",
    `${sessionKey}.json`,
  );
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
  const directory = path.dirname(statePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ epochs }, null, 2)}\n`,
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

  const shown = skills.slice(0, maxListedSkills);
  const lines = shown.map(
    (skill) =>
      `- ${skill.name}${skill.description ? `: ${skill.description}` : ""}`,
  );
  const more =
    skills.length > shown.length
      ? `\n… and ${skills.length - shown.length} more`
      : "";
  return `Available skills (load by name with the skill tool):\n${lines.join("\n")}${more}`;
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

// The git summary spawns a `git status` subprocess and is rebuilt on every
// chat request (full snapshot on turn one, delta afterwards). A short TTL
// makes rapid-fire requests — retries, approval continuations — reuse the
// summary while staying fresh enough to reflect the agent's own file edits.
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

/**
 * Builds a compact `<environment>` block describing the workspace the chat is
 * running in, so the agent knows the repo it is operating on and reads files
 * from it instead of asking the user to paste code. Best-effort and bounded in
 * size; never throws.
 */
export async function buildWorkspaceContext({
  cwd,
  sessionId,
  relatedPaths,
  dataDir,
}: NestedWorkspaceInstructionOptions): Promise<string> {
  const [baseline, nestedInstructions, listing, git] = await Promise.all([
    buildWorkspaceInstructionBaseline({ cwd }),
    buildNestedWorkspaceInstructionBlock({
      cwd,
      sessionId,
      relatedPaths,
      dataDir,
    }),
    buildDirectoryListing(cwd),
    buildGitSummary(cwd),
  ]);
  const skills = buildAvailableSkills(cwd);

  const today = new Date().toISOString().slice(0, 10);
  const parts = [
    baseline.block,
    nestedInstructions ? `\n${nestedInstructions}` : "",
    "",
    "<environment>",
    `Working directory: ${cwd}`,
    `Platform: ${describePlatform()}`,
    `Date: ${today}`,
    "",
    "Git:",
    git,
    "",
    "Top-level entries:",
    listing,
    skills ? `\n${skills}` : "",
    "</environment>",
  ];

  const block = parts.join("\n");
  return block.length > maxBlockChars
    ? `${block.slice(0, maxBlockChars)}\n… (environment truncated)\n</environment>`
    : block;
}

/**
 * Compact per-turn refresh. The source-hashed instruction baseline is replayed
 * on every stateless provider request; only the non-authoritative directory
 * listing is omitted after turn one.
 */
export async function buildWorkspaceContextDelta({
  cwd,
  sessionId,
  relatedPaths,
  dataDir,
}: NestedWorkspaceInstructionOptions): Promise<string> {
  const [baseline, nestedInstructions, git] = await Promise.all([
    buildWorkspaceInstructionBaseline({ cwd }),
    buildNestedWorkspaceInstructionBlock({
      cwd,
      sessionId,
      relatedPaths,
      dataDir,
    }),
    buildGitSummary(cwd),
  ]);
  const skills = buildAvailableSkills(cwd);

  const today = new Date().toISOString().slice(0, 10);
  return [
    baseline.block,
    nestedInstructions ? `\n${nestedInstructions}` : "",
    "",
    "<environment>",
    `Working directory: ${cwd}`,
    `Platform: ${describePlatform()}`,
    `Date: ${today}`,
    "(Top-level listing is available through list_files; current git state follows.)",
    "",
    "Git:",
    git,
    skills ? `\n${skills}` : "",
    "</environment>",
  ].join("\n");
}
