import { z } from "zod";
import { sessionIdentifierSchema } from "./chat-schemas";

/** Opaque, server-minted id for one changed file; never a host path. */
export const sessionChangeFileIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22}$/);

export const sessionChangeKindSchema = z.enum([
  "created",
  "modified",
  "deleted",
  "renamed",
  "untracked",
]);
export type SessionChangeKind = z.infer<typeof sessionChangeKindSchema>;

export const sessionChangedFileSchema = z
  .object({
    fileId: sessionChangeFileIdSchema,
    /** Workspace-relative path with forward slashes. */
    path: z.string().min(1).max(4_096),
    originalPath: z.string().max(4_096).nullable(),
    changeKind: sessionChangeKindSchema,
    /** Null when git reports a binary file or no counts are available. */
    added: z.number().int().nonnegative().nullable(),
    removed: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type SessionChangedFile = z.infer<typeof sessionChangedFileSchema>;

export const sessionChangesResponseSchema = z
  .object({
    isRepo: z.boolean(),
    branch: z.string().nullable(),
    files: z.array(sessionChangedFileSchema),
    truncated: z.boolean(),
  })
  .strict();
export type SessionChangesResponse = z.infer<typeof sessionChangesResponseSchema>;

export const sessionChangeDiffParamsSchema = z
  .object({
    id: sessionIdentifierSchema,
    fileId: sessionChangeFileIdSchema,
  })
  .strict();

export const sessionChangeDiffResponseSchema = z
  .object({
    path: z.string().min(1),
    diff: z.string(),
    truncated: z.boolean(),
    binary: z.boolean(),
  })
  .strict();
export type SessionChangeDiffResponse = z.infer<
  typeof sessionChangeDiffResponseSchema
>;

/** Map a porcelain XY status pair to a change kind (matches the TUI). */
export function changeKindFromGitStatus(
  indexStatus: string,
  workingTreeStatus: string,
): SessionChangeKind {
  if (indexStatus === "?" || workingTreeStatus === "?") {
    return "untracked";
  }
  const code = (workingTreeStatus.trim() || indexStatus.trim()).toUpperCase();
  switch (code) {
    case "A":
      return "created";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return "modified";
  }
}
