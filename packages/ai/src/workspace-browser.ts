import { z } from "zod";
import { codingAgentModeSchema } from "./coding-agent-modes";
import { permissionModeSchema } from "./permissions";

export const workspaceLocationIdSchema = z.enum([
  "desktop",
  "home",
  "documents",
  "downloads",
  "projects",
]);
export type WorkspaceLocationId = z.infer<typeof workspaceLocationIdSchema>;

export const workspaceLocationStateSchema = z.enum([
  "unprobed",
  "available",
]);

export const workspaceLocationSchema = z
  .object({
    id: workspaceLocationIdSchema,
    name: z.string().min(1).max(120),
    kind: z.literal("known-folder"),
    state: workspaceLocationStateSchema,
    pathLabel: z.string().min(1).max(4_096),
  })
  .strict();
export type WorkspaceLocation = z.infer<typeof workspaceLocationSchema>;

export const workspaceLocationsResponseSchema = z
  .object({
    locations: z.array(workspaceLocationSchema),
  })
  .strict();
export type WorkspaceLocationsResponse = z.infer<
  typeof workspaceLocationsResponseSchema
>;

export const workspaceBrowserOpenRequestSchema = z
  .object({
    locationId: workspaceLocationIdSchema,
  })
  .strict();

export const workspaceBrowserIdSchema = z.string().uuid();

export const workspaceBrowserOpenResponseSchema = z
  .object({
    browserId: workspaceBrowserIdSchema,
    location: workspaceLocationSchema,
    expiresAt: z.string().min(1),
  })
  .strict();
export type WorkspaceBrowserOpenResponse = z.infer<
  typeof workspaceBrowserOpenResponseSchema
>;

/**
 * Browser paths are arrays of plain names instead of host paths. Requiring one
 * segment per directory level makes traversal, drive letters, UNC paths, and
 * encoded separators invalid before they reach the filesystem boundary.
 */
export const workspacePathSegmentSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value !== "." && value !== "..", {
    message: "Workspace path segments cannot be dot segments.",
  })
  .refine((value) => !/[\0/\\]/.test(value), {
    message: "Workspace path segments cannot contain path separators.",
  });

export const workspacePathSegmentsSchema = z
  .array(workspacePathSegmentSchema)
  .max(128);

export const workspaceBrowserCursorSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

export const workspaceBrowserEntriesRequestSchema = z
  .object({
    segments: workspacePathSegmentsSchema.default([]),
    cursor: workspaceBrowserCursorSchema.optional(),
    limit: z.number().int().min(1).max(200).default(80),
    includeHidden: z.boolean().default(false),
  })
  .strict();

export const workspaceBrowserEntryKindSchema = z.enum([
  "file",
  "directory",
  "symlink",
  "other",
]);

export const workspaceBrowserSymlinkStateSchema = z.enum([
  "internal",
  "external",
  "broken",
]);

export const workspaceBrowserEntrySchema = z
  .object({
    name: z.string().min(1).max(255),
    kind: workspaceBrowserEntryKindSchema,
    size: z.number().int().nonnegative().nullable(),
    readable: z.boolean(),
    symlinkState: workspaceBrowserSymlinkStateSchema.nullable(),
  })
  .strict();
export type WorkspaceBrowserEntry = z.infer<
  typeof workspaceBrowserEntrySchema
>;

export const workspaceBrowserEntriesResponseSchema = z
  .object({
    browserId: workspaceBrowserIdSchema,
    segments: workspacePathSegmentsSchema,
    entries: z.array(workspaceBrowserEntrySchema),
    nextCursor: workspaceBrowserCursorSchema.nullable(),
    truncated: z.boolean(),
  })
  .strict();
export type WorkspaceBrowserEntriesResponse = z.infer<
  typeof workspaceBrowserEntriesResponseSchema
>;

export const workspaceBrowserSelectRequestSchema = z
  .object({
    segments: workspacePathSegmentsSchema.default([]),
  })
  .strict();

export const workspaceGrantIdSchema = z.string().uuid();

export const workspaceGrantSchema = z
  .object({
    id: workspaceGrantIdSchema,
    name: z.string().min(1).max(255),
    pathLabel: z.string().min(1).max(4_096),
    createdAt: z.string().min(1),
  })
  .strict();
export type WorkspaceGrant = z.infer<typeof workspaceGrantSchema>;

export const workspaceNativePickerRequestSchema = z.object({}).strict();

export const workspaceNativePickerResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("selected"),
        workspace: workspaceGrantSchema,
      })
      .strict(),
    z
      .object({
        outcome: z.literal("cancelled"),
      })
      .strict(),
  ],
);
export type WorkspaceNativePickerResponse = z.infer<
  typeof workspaceNativePickerResponseSchema
>;

export const workspaceBrowserSelectResponseSchema = z
  .object({
    workspace: workspaceGrantSchema,
  })
  .strict();
export type WorkspaceBrowserSelectResponse = z.infer<
  typeof workspaceBrowserSelectResponseSchema
>;

export const workspaceSessionPathParamsSchema = z
  .object({
    workspaceId: workspaceGrantIdSchema,
  })
  .strict();

export const workspaceSessionCreateRequestSchema = z
  .object({
    mode: codingAgentModeSchema.optional(),
    permissionMode: permissionModeSchema.optional(),
    title: z.string().min(1).max(120).optional(),
  })
  .strict();

export const workspaceBrowserPathParamsSchema = z
  .object({
    browserId: workspaceBrowserIdSchema,
  })
  .strict();

export const workspaceApiErrorCodeSchema = z.enum([
  "invalid_request",
  "location_not_found",
  "os_permission_denied",
  "workspace_missing",
  "workspace_replaced",
  "workspace_not_directory",
  "workspace_symlink_escape",
  "workspace_symlink_broken",
  "workspace_symlink_not_traversable",
  "browser_capability_expired",
  "workspace_grant_not_found",
  "invalid_cursor",
  "workspace_unavailable",
  "native_picker_busy",
  "native_picker_unavailable",
  "native_picker_failed",
]);
export type WorkspaceApiErrorCode = z.infer<
  typeof workspaceApiErrorCodeSchema
>;

export const workspaceApiErrorResponseSchema = z
  .object({
    error: z.string().min(1),
    code: workspaceApiErrorCodeSchema,
    retryable: z.boolean(),
  })
  .strict();
export type WorkspaceApiErrorResponse = z.infer<
  typeof workspaceApiErrorResponseSchema
>;
