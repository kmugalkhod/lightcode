import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  resolveWithinWorkspace,
  toWorkspaceRelativePath,
  type WorkspaceContext,
  getDefaultWorkspaceContext,
} from "../common/resolve-within-workspace";
import { truncateText } from "../common/output-utils";
import {
  gitDiffInputSchema,
  gitDiffOutputSchema,
  gitLogInputSchema,
  gitLogOutputSchema,
  gitShowInputSchema,
  gitShowOutputSchema,
  gitStatusInputSchema,
  gitStatusOutputSchema,
  type gitCommandErrorSchema,
} from "./schema";

const execFileAsync = promisify(execFile);
const unitSeparator = "\x1f";

type GitCommandError = z.infer<typeof gitCommandErrorSchema>;
type GitRunResult =
  | { ok: true; stdout: string; stderr: string; exitCode: 0 }
  | { ok: false; error: GitCommandError };

type GitStatusInput = z.input<typeof gitStatusInputSchema>;
type GitDiffInput = z.input<typeof gitDiffInputSchema>;
type GitLogInput = z.input<typeof gitLogInputSchema>;
type GitShowInput = z.input<typeof gitShowInputSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStringProperty(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function getExitCode(error: Record<string, unknown>) {
  const code = error.code;
  return typeof code === "number" ? code : null;
}

async function runGit(
  args: string[],
  workspaceContext: WorkspaceContext,
  maxBuffer = 10 * 1024 * 1024,
): Promise<GitRunResult> {
  try {
    const result = await execFileAsync("git", args, {
      cwd: workspaceContext.root,
      maxBuffer,
      windowsHide: true,
    });

    return {
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
    };
  } catch (error) {
    const record = isRecord(error) ? error : {};
    const code = record.code;
    const codeText = typeof code === "string" ? code : "git_failed";
    const message =
      getStringProperty(record, "message") || "Git command failed.";

    return {
      ok: false,
      error: {
        code: codeText,
        message,
        exitCode: getExitCode(record),
        stdout: getStringProperty(record, "stdout"),
        stderr: getStringProperty(record, "stderr"),
      },
    };
  }
}

function resolveOptionalGitPath(
  inputPath: string | undefined,
  workspaceContext: WorkspaceContext,
) {
  if (!inputPath) {
    return null;
  }

  const resolvedPath = resolveWithinWorkspace(inputPath, {
    context: workspaceContext,
    allowMissing: true,
  });

  return toWorkspaceRelativePath(resolvedPath, workspaceContext);
}

function parseBranchLine(line: string) {
  const branchLine = line.replace(/^##\s*/, "");
  const [branchSegment, trackingSegment] = branchLine.split("...");
  const branch = branchSegment && branchSegment !== "No commits yet on "
    ? branchSegment.replace(/^No commits yet on\s+/, "")
    : null;
  const trackingMatch = trackingSegment?.match(/^([^\s]+)(?:\s+\[(.*)\])?/);
  const upstream = trackingMatch?.[1] ?? null;
  const trackingDetails = trackingMatch?.[2] ?? "";
  const aheadMatch = trackingDetails.match(/ahead\s+(\d+)/);
  const behindMatch = trackingDetails.match(/behind\s+(\d+)/);

  return {
    branch,
    upstream,
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
  };
}

function parseStatusEntries(stdout: string, maxEntries: number) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
  const branchInfo = lines[0]?.startsWith("##")
    ? parseBranchLine(lines[0])
    : { branch: null, upstream: null, ahead: 0, behind: 0 };
  const statusLines = lines.filter((line) => !line.startsWith("##"));
  const entries = statusLines.slice(0, maxEntries).map((line) => {
    const indexStatus = line[0] === " " ? "" : line[0] ?? "";
    const workingTreeStatus = line[1] === " " ? "" : line[1] ?? "";
    const rawPath = line.slice(3);
    const renameParts = rawPath.split(" -> ");
    const originalPath = renameParts.length > 1 ? renameParts[0] : null;
    const filePath = renameParts.length > 1 ? renameParts[1] : rawPath;

    return {
      path: filePath,
      indexStatus,
      workingTreeStatus,
      originalPath,
    };
  });

  return {
    ...branchInfo,
    entries,
    totalEntries: statusLines.length,
    truncated: statusLines.length > entries.length,
  };
}

export async function executeGitStatus(
  input: GitStatusInput,
  workspaceContext: WorkspaceContext = getDefaultWorkspaceContext(),
) {
  const parsedInput = gitStatusInputSchema.parse(input);
  const result = await runGit(
    ["status", "--porcelain=v1", "-b", "--untracked-files=all", "--", "."],
    workspaceContext,
  );

  if (!result.ok) {
    return gitStatusOutputSchema.parse({
      ok: false,
      cwd: workspaceContext.root,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      entries: [],
      totalEntries: 0,
      truncated: false,
      error: result.error,
    });
  }

  return gitStatusOutputSchema.parse({
    ok: true,
    cwd: workspaceContext.root,
    ...parseStatusEntries(result.stdout, parsedInput.maxEntries),
    error: null,
  });
}

export async function executeGitDiff(
  input: GitDiffInput,
  workspaceContext: WorkspaceContext = getDefaultWorkspaceContext(),
) {
  const parsedInput = gitDiffInputSchema.parse(input);
  const relativePath = resolveOptionalGitPath(parsedInput.path, workspaceContext);
  const args = ["diff", "--no-ext-diff", "--color=never"];

  if (parsedInput.staged) {
    args.push("--cached");
  }

  if (parsedInput.statOnly) {
    args.push("--stat");
  }

  args.push("--", relativePath ?? ".");

  const result = await runGit(args, workspaceContext);
  if (!result.ok) {
    return gitDiffOutputSchema.parse({
      ok: false,
      cwd: workspaceContext.root,
      path: relativePath,
      staged: parsedInput.staged,
      statOnly: parsedInput.statOnly,
      diff: "",
      truncated: false,
      error: result.error,
    });
  }

  const truncated = truncateText(result.stdout, parsedInput.maxChars);

  return gitDiffOutputSchema.parse({
    ok: true,
    cwd: workspaceContext.root,
    path: relativePath,
    staged: parsedInput.staged,
    statOnly: parsedInput.statOnly,
    diff: truncated.text,
    truncated: truncated.truncated,
    error: null,
  });
}

export async function executeGitLog(
  input: GitLogInput,
  workspaceContext: WorkspaceContext = getDefaultWorkspaceContext(),
) {
  const parsedInput = gitLogInputSchema.parse(input);
  const relativePath = resolveOptionalGitPath(parsedInput.path, workspaceContext);
  const args = [
    "log",
    "--date=iso-strict",
    `--format=%H${unitSeparator}%h${unitSeparator}%an${unitSeparator}%ae${unitSeparator}%ad${unitSeparator}%s`,
    "-n",
    String(parsedInput.maxCommits),
    "--",
    relativePath ?? ".",
  ];
  const result = await runGit(args, workspaceContext);

  if (!result.ok) {
    return gitLogOutputSchema.parse({
      ok: false,
      cwd: workspaceContext.root,
      path: relativePath,
      commits: [],
      totalCommits: 0,
      truncated: false,
      error: result.error,
    });
  }

  const commits = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [hash, shortHash, authorName, authorEmail, date, subject] =
        line.split(unitSeparator);

      return {
        hash: hash ?? "",
        shortHash: shortHash ?? "",
        authorName: authorName ?? "",
        authorEmail: authorEmail ?? "",
        date: date ?? "",
        subject: subject ?? "",
      };
    });

  return gitLogOutputSchema.parse({
    ok: true,
    cwd: workspaceContext.root,
    path: relativePath,
    commits,
    totalCommits: commits.length,
    truncated: commits.length >= parsedInput.maxCommits,
    error: null,
  });
}

export async function executeGitShow(
  input: GitShowInput,
  workspaceContext: WorkspaceContext = getDefaultWorkspaceContext(),
) {
  const parsedInput = gitShowInputSchema.parse(input);
  const relativePath = resolveOptionalGitPath(parsedInput.path, workspaceContext);
  const args = [
    "show",
    "--no-ext-diff",
    "--format=fuller",
    "--stat",
    "--patch",
    "--color=never",
    parsedInput.revision,
    "--",
    relativePath ?? ".",
  ];
  const result = await runGit(args, workspaceContext);

  if (!result.ok) {
    return gitShowOutputSchema.parse({
      ok: false,
      cwd: workspaceContext.root,
      revision: parsedInput.revision,
      path: relativePath,
      content: "",
      truncated: false,
      error: result.error,
    });
  }

  const truncated = truncateText(result.stdout, parsedInput.maxChars);

  return gitShowOutputSchema.parse({
    ok: true,
    cwd: workspaceContext.root,
    revision: parsedInput.revision,
    path: relativePath,
    content: truncated.text,
    truncated: truncated.truncated,
    error: null,
  });
}
