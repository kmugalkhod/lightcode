import { zValidator } from "@hono/zod-validator";
import {
  changeKindFromGitStatus,
  sessionChangeDiffParamsSchema,
  sessionChangeDiffResponseSchema,
  sessionChangesResponseSchema,
  sessionPathParamsSchema,
  type SessionChangedFile,
} from "@lightcode/ai";
import {
  createWorkspaceContext,
  executeGitDiff,
  executeGitNumstat,
  executeGitStatus,
} from "@lightcode/ai/runtime";
import { createHmac, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import {
  assertSessionWorkspaceIdentity,
  resolveChatSessionIdentifier,
  SessionNotFoundError,
  SessionWorkspaceIdentityError,
} from "../lib/chat-store";
import { internalErrorResponse } from "./route-helpers";

const maximumUntrackedBytes = 256 * 1_024;
const maximumChangedFiles = 500;

type GitStatus = Awaited<ReturnType<typeof executeGitStatus>>;
type GitStatusEntry = GitStatus["entries"][number];

export interface SessionChangesRoutesOptions {
  /** Test seam: resolve a session id to its canonical workspace folder. */
  resolveSessionWorkspace?: (sessionId: string) => Promise<string>;
}

async function defaultResolveSessionWorkspace(id: string): Promise<string> {
  const sessionId = await resolveChatSessionIdentifier(id);
  return (await assertSessionWorkspaceIdentity(sessionId)).cwd;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * An untracked file has no git diff, so show it as an all-added file. The
 * path comes from git but is still kept inside the workspace and is never
 * followed through a symlink.
 */
async function untrackedFileDiff(
  workspace: string,
  relativePath: string,
): Promise<{ diff: string; truncated: boolean; binary: boolean }> {
  const candidate = path.resolve(workspace, relativePath);
  const stats = await fs.lstat(candidate).catch(() => null);
  if (!stats || !stats.isFile() || !isContained(workspace, candidate)) {
    return { diff: "", truncated: false, binary: false };
  }
  const handle = await fs.open(candidate, "r");
  try {
    const length = Math.min(stats.size, maximumUntrackedBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    if (buffer.includes(0)) {
      return { diff: "", truncated: false, binary: true };
    }
    const lines = buffer.toString("utf8").replace(/\r\n/g, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const diff = [
      "--- /dev/null",
      `+++ b/${relativePath}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join("\n");
    return { diff, truncated: stats.size > maximumUntrackedBytes, binary: false };
  } finally {
    await handle.close();
  }
}

function errorResponse(c: Context, error: unknown, event: string) {
  if (error instanceof SessionNotFoundError) {
    return c.json({ error: error.message }, 404);
  }
  if (error instanceof SessionWorkspaceIdentityError) {
    return c.json(
      { error: error.message, code: error.code },
      error.code === "workspace_unavailable" ? 404 : 409,
    );
  }
  return internalErrorResponse(c, {
    event,
    message: "Unable to read the session's changes.",
    error,
  });
}

/**
 * Git changes in a session's workspace for the web Changes panel. Files are
 * addressed by opaque ids minted per process, never by host paths.
 */
export function createSessionChangesRoutes(
  options: SessionChangesRoutesOptions = {},
) {
  const resolveSessionWorkspace =
    options.resolveSessionWorkspace ?? defaultResolveSessionWorkspace;
  const fileIdSecret = randomBytes(32);
  const fileId = (workspace: string, entryPath: string) =>
    createHmac("sha256", fileIdSecret)
      .update(`${workspace}\0${entryPath}`)
      .digest("base64url")
      .slice(0, 22);

  return new Hono()
    .get("/:id/changes", zValidator("param", sessionPathParamsSchema), async (c) => {
      try {
        const workspace = await resolveSessionWorkspace(c.req.valid("param").id);
        const context = createWorkspaceContext(workspace);
        const status = await executeGitStatus({}, context);
        if (!status.ok) {
          return c.json(
            sessionChangesResponseSchema.parse({
              isRepo: false,
              branch: null,
              files: [],
              truncated: false,
            }),
          );
        }
        const counts = await executeGitNumstat(context);
        const files: SessionChangedFile[] = status.entries
          .slice(0, maximumChangedFiles)
          .map((entry: GitStatusEntry) => {
            const lineCounts = counts.get(entry.path);
            return {
              fileId: fileId(workspace, entry.path),
              path: entry.path,
              originalPath: entry.originalPath,
              changeKind: changeKindFromGitStatus(
                entry.indexStatus,
                entry.workingTreeStatus,
              ),
              added: lineCounts ? lineCounts.added : null,
              removed: lineCounts ? lineCounts.removed : null,
            };
          });
        return c.json(
          sessionChangesResponseSchema.parse({
            isRepo: true,
            branch: status.branch,
            files,
            truncated:
              status.truncated || status.entries.length > maximumChangedFiles,
          }),
        );
      } catch (error) {
        return errorResponse(c, error, "session_changes_failed");
      }
    })
    .get(
      "/:id/changes/:fileId/diff",
      zValidator("param", sessionChangeDiffParamsSchema),
      async (c) => {
        try {
          const params = c.req.valid("param");
          const workspace = await resolveSessionWorkspace(params.id);
          const context = createWorkspaceContext(workspace);
          const status = await executeGitStatus({}, context);
          const entry = status.ok
            ? status.entries.find(
                (candidate: GitStatusEntry) =>
                  fileId(workspace, candidate.path) === params.fileId,
              )
            : undefined;
          if (!entry) {
            return c.json(
              { error: "That file is no longer changed. Refresh the list." },
              404,
            );
          }

          if (changeKindFromGitStatus(entry.indexStatus, entry.workingTreeStatus) === "untracked") {
            return c.json(
              sessionChangeDiffResponseSchema.parse({
                path: entry.path,
                ...(await untrackedFileDiff(workspace, entry.path)),
              }),
            );
          }

          let result = await executeGitDiff({ path: entry.path }, context);
          // Fall back to the staged diff when nothing is unstaged.
          if (result.ok && !result.diff.trim()) {
            const staged = await executeGitDiff(
              { path: entry.path, staged: true },
              context,
            );
            if (staged.ok && staged.diff.trim()) result = staged;
          }
          return c.json(
            sessionChangeDiffResponseSchema.parse({
              path: entry.path,
              diff: result.ok ? result.diff : "",
              truncated: result.ok ? result.truncated : false,
              binary: result.ok && /^Binary files /m.test(result.diff),
            }),
          );
        } catch (error) {
          return errorResponse(c, error, "session_change_diff_failed");
        }
      },
    );
}

export const sessionChangesRoutes = createSessionChangesRoutes();
