import { createWorkspaceContext, executeGitStatus } from "@lightcode/ai/runtime";
import { createLogger, getErrorMessage } from "@lightcode/shared";
import { readFile, readdir } from "node:fs/promises";
import { platform } from "node:os";
import path from "node:path";

const logger = createLogger("workspace-context");

/** Project instruction files to surface, in priority order. */
const projectDocNames = ["AGENTS.md", "CLAUDE.md", "README.md"] as const;

const maxListedEntries = 40;
const maxDocChars = 1_500;
const maxBlockChars = 8_000;

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

async function buildGitSummary(cwd: string): Promise<string> {
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

async function buildProjectDocs(cwd: string): Promise<string> {
  const sections: string[] = [];
  for (const name of projectDocNames) {
    try {
      const content = (await readFile(path.join(cwd, name), "utf8")).trim();
      if (!content) {
        continue;
      }
      const truncated =
        content.length > maxDocChars
          ? `${content.slice(0, maxDocChars)}\n… (truncated)`
          : content;
      sections.push(`### ${name}\n${truncated}`);
    } catch {
      // File absent or unreadable — skip silently.
    }
  }
  return sections.join("\n\n");
}

/**
 * Builds a compact `<environment>` block describing the workspace the chat is
 * running in, so the agent knows the repo it is operating on and reads files
 * from it instead of asking the user to paste code. Best-effort and bounded in
 * size; never throws.
 */
export async function buildWorkspaceContext({
  cwd,
}: {
  cwd: string;
}): Promise<string> {
  const [listing, git, docs] = await Promise.all([
    buildDirectoryListing(cwd),
    buildGitSummary(cwd),
    buildProjectDocs(cwd),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const parts = [
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
    docs ? `\nProject instructions:\n${docs}` : "",
    "</environment>",
  ];

  const block = parts.join("\n");
  return block.length > maxBlockChars
    ? `${block.slice(0, maxBlockChars)}\n… (environment truncated)\n</environment>`
    : block;
}
