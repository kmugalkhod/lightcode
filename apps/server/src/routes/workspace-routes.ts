import { zValidator } from "@hono/zod-validator";
import {
  sessionCreateResponseSchema,
  workspaceBrowserEntriesRequestSchema,
  workspaceBrowserEntriesResponseSchema,
  workspaceBrowserOpenRequestSchema,
  workspaceBrowserOpenResponseSchema,
  workspaceBrowserPathParamsSchema,
  workspaceBrowserSelectRequestSchema,
  workspaceBrowserSelectResponseSchema,
  workspaceGrantSchema,
  workspaceLaunchFolderGrantRequestSchema,
  workspaceLaunchFolderResponseSchema,
  workspaceLocationsResponseSchema,
  workspaceNativePickerRequestSchema,
  workspaceNativePickerResponseSchema,
  workspaceRecentGrantRequestSchema,
  workspaceRecentPathParamsSchema,
  workspaceRecentProjectsResponseSchema,
  workspaceSessionCreateRequestSchema,
  workspaceSessionPathParamsSchema,
  type WorkspaceApiErrorCode,
  type WorkspaceBrowserEntry,
  type WorkspaceGrant,
  type WorkspaceLocation,
  type WorkspaceLocationId,
} from "@lightcode/ai";
import { createLogger, getErrorMessage } from "@lightcode/shared";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  createChatSession,
  listRecentWorkspaces as listRecentSessionWorkspaces,
  SessionWorkspaceIdentityError,
  type RecentWorkspace,
} from "../lib/chat-store";
import {
  chatModelId,
  lightcodeConfigResult,
} from "../lib/runtime-config";
import {
  createNativeDirectoryPicker,
  NativeDirectoryPickerError,
  type NativeDirectoryPicker,
} from "../lib/native-directory-picker";
import { isAuthenticatedWebRequest } from "../lib/web-auth";
import {
  resolveWindowsKnownFolder,
  resolveWindowsKnownFolders,
} from "../lib/windows-known-folders";
import {
  isHiddenBrowserEntry,
  isOmittedFromFolderListing,
} from "../lib/workspace-entry-filter";
import {
  listWindowsDrives,
  windowsDriveRoot,
  windowsDriveTokenPattern,
  type WindowsDrive,
} from "../lib/workspace-drives";

const logger = createLogger("workspace-routes");
const defaultBrowserCapabilityTtlMs = 10 * 60 * 1_000;
const maximumBrowserCapabilities = 64;
const maximumWorkspaceGrants = 256;
const maximumUserDirsConfigurationBytes = 16 * 1_024;
const nativePickerMaximumMs = 10 * 60 * 1_000;

interface RootIdentity {
  device: string;
  inode: string;
}

interface BrowserCapability {
  id: string;
  /** "drives" capabilities have no single root; each drive is its own root. */
  kind: "folder" | "drives";
  root: string;
  identity: RootIdentity;
  location: WorkspaceLocation;
  rootName: string;
  expiresAtMs: number;
  /** Drive tokens this capability listed; only these may be opened. */
  driveTokens?: Set<string>;
}

/** The root, remaining segments, and display name a browser request resolves to. */
interface BrowseScope {
  root: string;
  segments: readonly string[];
  rootName: string;
}

interface StoredWorkspaceGrant extends WorkspaceGrant {
  root: string;
  identity: RootIdentity;
}

type CreateSessionInput = Parameters<typeof createChatSession>[0];

export interface WorkspaceRoutesOptions {
  /** Server-owned path overrides. Browser requests never supply host paths. */
  locationPaths?: Partial<Record<WorkspaceLocationId, string>>;
  /** Lazy resolver seams for known folders. They run only after an open request. */
  resolveLocationPaths?: Partial<
    Record<WorkspaceLocationId, () => Promise<string>>
  >;
  locationPathLabels?: Partial<Record<WorkspaceLocationId, string>>;
  desktopPath?: string;
  desktopPathLabel?: string;
  resolveDesktopPath?: () => Promise<string>;
  browserCapabilityTtlMs?: number;
  now?: () => number;
  /** Test seam for deterministic filesystem replacement-race coverage. */
  beforeDirectoryOperation?: (input: {
    operation: "list" | "select";
    directory: string;
  }) => Promise<void>;
  createSession?: (
    input: CreateSessionInput,
  ) => Promise<{ id: string }>;
  /** Injectable seam; tests must never open a real host dialog. */
  nativeDirectoryPicker?: NativeDirectoryPicker;
  /**
   * Gates grants of folders the browser did not navigate to (native picker,
   * launch folder). Defaults to the authenticated global web middleware marker.
   */
  authorizeNativePickerRequest?: (request: Request) => boolean;
  /** Folder `lightcode web` started from. Defaults to LIGHTCODE_WEB_LAUNCH_CWD. */
  launchFolderPath?: string | null;
  /** Offers the Windows Drives location. Defaults to true on win32. */
  enableDrives?: boolean;
  /** Test seams for drive enumeration and each drive's root folder. */
  listDrives?: () => Promise<WindowsDrive[]>;
  driveRoot?: (token: string) => string;
  /**
   * Starts known-folder discovery when the chooser lists locations, so the
   * first open does not wait on PowerShell. Defaults to the Windows resolver
   * when no location paths are overridden.
   */
  prewarmKnownFolders?: () => void;
  /** Test seam for the session store's recent folders. */
  listRecentWorkspaces?: (limit: number) => Promise<RecentWorkspace[]>;
}

const launchFolderEnvironmentSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes("\0"))
  .refine((value) => path.isAbsolute(value));

function parseLaunchFolderPath(value: unknown): string | null {
  const parsed = launchFolderEnvironmentSchema.safeParse(value);
  return parsed.success
    ? normalizeKnownFolderCandidate(parsed.data, process.platform)
    : null;
}

class WorkspaceRouteError extends Error {
  constructor(
    readonly code: WorkspaceApiErrorCode,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410 | 422 | 500 | 503,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "WorkspaceRouteError";
  }
}

type DesktopResolverPlatform = typeof process.platform;

type KnownFolderProbeResult =
  | "available"
  | "missing"
  | "permission-denied";
type UserDirectoryKind = "documents" | "downloads";

export interface DesktopPathResolverOptions {
  platform?: DesktopResolverPlatform;
  homeDirectory?: string;
  environment?: Record<string, string | undefined>;
  /** Dependency seam used by the cross-platform resolver tests. */
  probeDirectory?: (candidate: string) => Promise<KnownFolderProbeResult>;
  /** Dependency seam used to parse Linux's user-dirs.dirs on any host OS. */
  readUserDirsConfiguration?: (filePath: string) => Promise<string | null>;
  /** Dependency seam for Windows Known Folder redirection discovery. */
  resolveWindowsKnownFolder?: () => Promise<string | null>;
}

export interface UserDirectoryPathResolverOptions {
  platform?: DesktopResolverPlatform;
  homeDirectory?: string;
  environment?: Record<string, string | undefined>;
  /** Dependency seams keep platform discovery deterministic in tests. */
  probeDirectory?: (candidate: string) => Promise<KnownFolderProbeResult>;
  readUserDirsConfiguration?: (filePath: string) => Promise<string | null>;
  resolveWindowsKnownFolder?: () => Promise<string | null>;
}

export interface ProjectsPathResolverOptions {
  platform?: DesktopResolverPlatform;
  homeDirectory?: string;
  environment?: Record<string, string | undefined>;
  /** Dependency seam; probing happens only when Projects is explicitly opened. */
  probeDirectory?: (candidate: string) => Promise<KnownFolderProbeResult>;
}

function pathImplementation(platform: DesktopResolverPlatform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function isFilesystemRootPath(
  candidate: string,
  platform: DesktopResolverPlatform = process.platform,
): boolean {
  const pathApi = pathImplementation(platform);
  const normalized = pathApi.normalize(candidate);
  return normalized === pathApi.parse(normalized).root;
}

function normalizeKnownFolderCandidate(
  candidate: string,
  platform: DesktopResolverPlatform,
): string | null {
  if (candidate.includes("\0")) {
    return null;
  }
  const pathApi = pathImplementation(platform);
  if (!pathApi.isAbsolute(candidate)) {
    return null;
  }
  const normalized = pathApi.normalize(candidate);
  if (isFilesystemRootPath(normalized, platform)) {
    return null;
  }
  return normalized;
}

async function probeDirectory(
  candidate: string,
): Promise<KnownFolderProbeResult> {
  try {
    const metadata = await fs.stat(candidate);
    return metadata.isDirectory() ? "available" : "missing";
  } catch (error) {
    const code = filesystemErrorCode(error);
    if (code === "EACCES" || code === "EPERM") {
      return "permission-denied";
    }
    return "missing";
  }
}

async function readSmallUserDirsConfiguration(
  filePath: string,
): Promise<string | null> {
  const noFollowFlag =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollowFlag);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > maximumUserDirsConfigurationBytes
    ) {
      return null;
    }
    return await handle.readFile("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseXdgUserDirectory(
  contents: string,
  homeDirectory: string,
  variableName:
    | "XDG_DESKTOP_DIR"
    | "XDG_DOCUMENTS_DIR"
    | "XDG_DOWNLOAD_DIR",
): string | null {
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(XDG_(?:DESKTOP|DOCUMENTS|DOWNLOAD)_DIR)="([^"\r\n]*)"\s*$/,
    );
    if (!match || match[1] !== variableName) {
      continue;
    }
    const configured = match[2];
    if (!configured || configured.includes("\0") || /[`]/.test(configured)) {
      return null;
    }
    if (configured === "$HOME" || configured === "${HOME}") {
      // xdg-user-dirs uses the home directory itself to mean "disabled".
      return null;
    }
    if (configured.startsWith("$HOME/")) {
      return path.posix.resolve(homeDirectory, configured.slice(6));
    }
    if (configured.startsWith("${HOME}/")) {
      return path.posix.resolve(homeDirectory, configured.slice(8));
    }
    if (configured.includes("$")) {
      return null;
    }
    return path.posix.isAbsolute(configured)
      ? path.posix.normalize(configured)
      : null;
  }
  return null;
}

async function firstUsableKnownFolder(
  candidates: Array<string | null | undefined>,
  platform: DesktopResolverPlatform,
  probe: (candidate: string) => Promise<KnownFolderProbeResult>,
): Promise<string | null> {
  const seen = new Set<string>();
  for (const unvalidated of candidates) {
    if (!unvalidated) {
      continue;
    }
    const candidate = normalizeKnownFolderCandidate(unvalidated, platform);
    if (!candidate) {
      continue;
    }
    const key = platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const state = await probe(candidate);
    if (state === "available" || state === "permission-denied") {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolves the operating system's Desktop known folder without exposing a raw
 * browser-supplied path. Existence checks are intentionally deferred until
 * the user opens Desktop, which also avoids triggering macOS TCC at startup.
 */
export async function resolveDesktopDirectoryPath(
  options: DesktopPathResolverOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const pathApi = pathImplementation(platform);
  const environment = options.environment ?? Bun.env;
  const homeDirectory = pathApi.normalize(
    options.homeDirectory ?? homedir(),
  );
  const explicit = environment.LIGHTCODE_DESKTOP_PATH?.trim();
  if (explicit) {
    const normalized = normalizeKnownFolderCandidate(explicit, platform);
    if (!normalized) {
      throw new WorkspaceRouteError(
        "workspace_unavailable",
        "LIGHTCODE_DESKTOP_PATH must be an absolute folder path and cannot be a filesystem root.",
        500,
        false,
      );
    }
    return normalized;
  }

  const probe = options.probeDirectory ?? probeDirectory;

  if (platform === "win32") {
    const userProfile = environment.USERPROFILE?.trim() || homeDirectory;
    const knownFolder = await (
      options.resolveWindowsKnownFolder ??
      (() => resolveWindowsKnownFolder(environment, "desktop"))
    )();
    const candidates = [
      knownFolder,
      environment.OneDrive,
      environment.OneDriveConsumer,
      environment.OneDriveCommercial,
    ]
      .flatMap((base, index) => {
        const trimmed = base?.trim();
        if (!trimmed) {
          return [];
        }
        // The OS Known Folder API returns Desktop itself; OneDrive variables
        // point at a storage root and therefore need the Desktop suffix.
        return [
          index === 0 ? trimmed : path.win32.join(trimmed, "Desktop"),
        ];
      });
    candidates.push(path.win32.join(userProfile, "Desktop"));
    return (
      (await firstUsableKnownFolder(candidates, platform, probe)) ??
      path.win32.join(homeDirectory, "Desktop")
    );
  }

  if (platform === "linux") {
    const configHome = environment.XDG_CONFIG_HOME?.trim();
    const safeConfigHome =
      configHome && path.posix.isAbsolute(configHome)
        ? path.posix.normalize(configHome)
        : path.posix.join(homeDirectory, ".config");
    const readConfiguration =
      options.readUserDirsConfiguration ?? readSmallUserDirsConfiguration;
    const contents = await readConfiguration(
      path.posix.join(safeConfigHome, "user-dirs.dirs"),
    );
    const configured = contents
      ? parseXdgUserDirectory(
          contents,
          homeDirectory,
          "XDG_DESKTOP_DIR",
        )
      : null;
    if (configured) {
      const selected = await firstUsableKnownFolder(
        [configured],
        platform,
        probe,
      );
      if (selected) {
        return selected;
      }
    }
  }

  return pathApi.join(homeDirectory, "Desktop");
}

async function resolveUserDirectoryPath(
  folder: UserDirectoryKind,
  options: UserDirectoryPathResolverOptions,
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const pathApi = pathImplementation(platform);
  const environment = options.environment ?? Bun.env;
  const homeDirectory = pathApi.normalize(
    options.homeDirectory ?? homedir(),
  );
  const displayName = folder === "documents" ? "Documents" : "Downloads";
  const overrideName =
    folder === "documents"
      ? "LIGHTCODE_DOCUMENTS_PATH"
      : "LIGHTCODE_DOWNLOADS_PATH";
  const explicit = environment[overrideName]?.trim();
  if (explicit) {
    const normalized = normalizeKnownFolderCandidate(explicit, platform);
    if (!normalized) {
      throw new WorkspaceRouteError(
        "workspace_unavailable",
        `${overrideName} must be an absolute folder path and cannot be a filesystem root.`,
        500,
        false,
      );
    }
    return normalized;
  }

  const probe = options.probeDirectory ?? probeDirectory;
  if (platform === "win32") {
    const knownFolder = await (
      options.resolveWindowsKnownFolder ??
      (() => resolveWindowsKnownFolder(environment, folder))
    )();
    const userProfile = environment.USERPROFILE?.trim() || homeDirectory;
    const cloudRoots = [
      environment.OneDrive,
      environment.OneDriveConsumer,
      environment.OneDriveCommercial,
    ];
    const candidates = [
      knownFolder,
      ...cloudRoots.map((root) =>
        root?.trim() ? path.win32.join(root.trim(), displayName) : null,
      ),
      path.win32.join(userProfile, displayName),
      path.win32.join(homeDirectory, displayName),
    ];
    return (
      (await firstUsableKnownFolder(candidates, platform, probe)) ??
      path.win32.join(homeDirectory, displayName)
    );
  }

  if (platform === "linux") {
    const configHome = environment.XDG_CONFIG_HOME?.trim();
    const safeConfigHome =
      configHome && path.posix.isAbsolute(configHome)
        ? path.posix.normalize(configHome)
        : path.posix.join(homeDirectory, ".config");
    const readConfiguration =
      options.readUserDirsConfiguration ?? readSmallUserDirsConfiguration;
    const contents = await readConfiguration(
      path.posix.join(safeConfigHome, "user-dirs.dirs"),
    );
    const configured = contents
      ? parseXdgUserDirectory(
          contents,
          homeDirectory,
          folder === "documents"
            ? "XDG_DOCUMENTS_DIR"
            : "XDG_DOWNLOAD_DIR",
        )
      : null;
    const selected = await firstUsableKnownFolder(
      [configured],
      platform,
      probe,
    );
    if (selected) {
      return selected;
    }
  }

  return pathApi.join(homeDirectory, displayName);
}

/** Resolves the user's OS-configured Documents folder only after it is opened. */
export function resolveDocumentsDirectoryPath(
  options: UserDirectoryPathResolverOptions = {},
): Promise<string> {
  return resolveUserDirectoryPath("documents", options);
}

/** Resolves the user's OS-configured Downloads folder only after it is opened. */
export function resolveDownloadsDirectoryPath(
  options: UserDirectoryPathResolverOptions = {},
): Promise<string> {
  return resolveUserDirectoryPath("downloads", options);
}

/**
 * Resolves a conventional Projects folder lazily. Both common casings are
 * supported on case-sensitive systems, and an explicit override wins. The
 * returned folder is still canonicalized and identity-bound by the route.
 */
export async function resolveProjectsDirectoryPath(
  options: ProjectsPathResolverOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const pathApi = pathImplementation(platform);
  const environment = options.environment ?? Bun.env;
  const homeDirectory = pathApi.normalize(
    options.homeDirectory ?? homedir(),
  );
  const explicit = environment.LIGHTCODE_PROJECTS_PATH?.trim();
  if (explicit) {
    const normalized = normalizeKnownFolderCandidate(explicit, platform);
    if (!normalized) {
      throw new WorkspaceRouteError(
        "workspace_unavailable",
        "LIGHTCODE_PROJECTS_PATH must be an absolute folder path and cannot be a filesystem root.",
        500,
        false,
      );
    }
    return normalized;
  }

  const probe = options.probeDirectory ?? probeDirectory;
  const candidates = [
    pathApi.join(homeDirectory, "Projects"),
    pathApi.join(homeDirectory, "projects"),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const state = await probe(candidate);
    if (state === "available" || state === "permission-denied") {
      return candidate;
    }
  }
  return candidates[0];
}

function filesystemErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function mapFilesystemError(error: unknown): WorkspaceRouteError {
  if (error instanceof SessionWorkspaceIdentityError) {
    return new WorkspaceRouteError(
      error.code === "workspace_unavailable"
        ? "workspace_unavailable"
        : "workspace_replaced",
      error.message,
      error.code === "workspace_unavailable" ? 404 : 409,
      true,
    );
  }
  const code = filesystemErrorCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return new WorkspaceRouteError(
      "os_permission_denied",
      "Lightcode does not have permission to access this folder.",
      403,
      true,
    );
  }
  if (code === "ENOENT") {
    return new WorkspaceRouteError(
      "workspace_missing",
      "The selected folder is no longer available.",
      404,
      true,
    );
  }
  if (code === "ENOTDIR") {
    return new WorkspaceRouteError(
      "workspace_not_directory",
      "The selected path is not a directory.",
      422,
      false,
    );
  }

  return new WorkspaceRouteError(
    "workspace_unavailable",
    "Unable to access the selected workspace.",
    500,
    true,
  );
}

function mapNativePickerError(error: unknown): WorkspaceRouteError {
  if (error instanceof NativeDirectoryPickerError) {
    logger.warn("native_picker_error", {
      code: error.code,
      ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
    });
  } else {
    logger.warn("native_picker_error", {
      code: "native_picker_failed",
      error: getErrorMessage(error),
    });
  }
  if (!(error instanceof NativeDirectoryPickerError)) {
    return new WorkspaceRouteError(
      "native_picker_failed",
      "The system folder picker could not be opened.",
      500,
      true,
    );
  }
  if (error.code === "native_picker_busy") {
    return new WorkspaceRouteError(
      error.code,
      "A folder picker is already open.",
      409,
      true,
    );
  }
  if (error.code === "native_picker_unavailable") {
    return new WorkspaceRouteError(
      error.code,
      "No supported system folder picker is available.",
      503,
      false,
    );
  }
  return new WorkspaceRouteError(
    error.code,
    "The system folder picker could not be opened.",
    500,
    true,
  );
}

function workspaceErrorResponse(c: Context, error: unknown) {
  const mapped =
    error instanceof WorkspaceRouteError ? error : mapFilesystemError(error);
  if (mapped.status === 500) {
    logger.error("workspace_request_failed", {
      error: getErrorMessage(mapped),
    });
  }
  return c.json(
    {
      error: mapped.message,
      code: mapped.code,
      retryable: mapped.retryable,
    },
    mapped.status,
  );
}

function invalidRequestResponse(c: Context) {
  return c.json(
    {
      error: "Invalid workspace browser request.",
      code: "invalid_request" as const,
      retryable: false,
    },
    400,
  );
}

function rootIdentity(stats: {
  dev: number | bigint;
  ino: number | bigint;
}): RootIdentity {
  if (stats.ino === 0 || stats.ino === 0n) {
    return { device: "unsupported", inode: "unsupported" };
  }
  return { device: String(stats.dev), inode: String(stats.ino) };
}

function identitiesMatch(left: RootIdentity, right: RootIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

/**
 * Bun's async realpath returns a drive root as a bare "D:", which Windows reads
 * as the current folder on that drive. Restore the separator so a drive root
 * stays the root.
 */
async function realpathPreservingDriveRoot(candidate: string): Promise<string> {
  const resolved = await fs.realpath(candidate);
  return /^[A-Za-z]:$/.test(resolved) ? `${resolved}${path.win32.sep}` : resolved;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function resolveKnownDirectory(directory: string): Promise<{
  root: string;
  identity: RootIdentity;
}> {
  try {
    const root = await realpathPreservingDriveRoot(path.resolve(directory));
    if (isFilesystemRootPath(root)) {
      throw new WorkspaceRouteError(
        "workspace_unavailable",
        "A filesystem root cannot be opened as a workspace location.",
        500,
        false,
      );
    }
    const stats = await fs.stat(root, { bigint: true });
    if (!stats.isDirectory()) {
      throw new WorkspaceRouteError(
        "workspace_not_directory",
        "The selected path is not a directory.",
        422,
        false,
      );
    }
    return { root, identity: rootIdentity(stats) };
  } catch (error) {
    if (error instanceof WorkspaceRouteError) {
      throw error;
    }
    throw mapFilesystemError(error);
  }
}

async function assertRootIdentity({
  root,
  identity,
}: {
  root: string;
  identity: RootIdentity;
}): Promise<void> {
  try {
    const canonical = await realpathPreservingDriveRoot(root);
    const stats = await fs.stat(canonical, { bigint: true });
    if (
      canonical !== root ||
      !stats.isDirectory() ||
      !identitiesMatch(identity, rootIdentity(stats))
    ) {
      throw new WorkspaceRouteError(
        "workspace_replaced",
        "The selected workspace changed on disk. Select it again before continuing.",
        409,
        true,
      );
    }
  } catch (error) {
    if (error instanceof WorkspaceRouteError) {
      throw error;
    }
    throw mapFilesystemError(error);
  }
}

async function symlinkFailure(
  root: string,
  candidate: string,
  locationName: string,
): Promise<WorkspaceRouteError> {
  try {
    const target = await realpathPreservingDriveRoot(candidate);
    if (!isContainedPath(root, target)) {
      return new WorkspaceRouteError(
        "workspace_symlink_escape",
        `This symbolic link points outside the allowed ${locationName} location.`,
        403,
        false,
      );
    }
    return new WorkspaceRouteError(
      "workspace_symlink_not_traversable",
      "Symbolic links cannot be used to navigate the workspace browser.",
      422,
      false,
    );
  } catch (error) {
    if (filesystemErrorCode(error) === "EACCES" || filesystemErrorCode(error) === "EPERM") {
      return mapFilesystemError(error);
    }
    return new WorkspaceRouteError(
      "workspace_symlink_broken",
      "This symbolic link is broken and cannot be opened.",
      422,
      false,
    );
  }
}

async function resolveDirectoryFromSegments(
  root: string,
  segments: readonly string[],
  locationName: string,
): Promise<{ path: string; identity: RootIdentity }> {
  let current = root;
  for (const segment of segments) {
    const candidate = path.join(current, segment);
    if (!isContainedPath(root, candidate)) {
      throw new WorkspaceRouteError(
        "workspace_symlink_escape",
        `The requested path is outside the allowed ${locationName} location.`,
        403,
        false,
      );
    }

    let stats;
    try {
      stats = await fs.lstat(candidate);
    } catch (error) {
      throw mapFilesystemError(error);
    }
    if (stats.isSymbolicLink()) {
      throw await symlinkFailure(root, candidate, locationName);
    }
    if (!stats.isDirectory()) {
      throw new WorkspaceRouteError(
        "workspace_not_directory",
        "The selected path is not a directory.",
        422,
        false,
      );
    }
    current = candidate;
  }

  const canonical = await realpathPreservingDriveRoot(current).catch((error) => {
    throw mapFilesystemError(error);
  });
  if (!isContainedPath(root, canonical)) {
    throw new WorkspaceRouteError(
      "workspace_symlink_escape",
      `The requested path is outside the allowed ${locationName} location.`,
      403,
      false,
    );
  }
  const metadata = await fs.lstat(canonical, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new WorkspaceRouteError(
      "workspace_replaced",
      "The selected folder changed while it was being opened.",
      409,
      true,
    );
  }
  return { path: canonical, identity: rootIdentity(metadata) };
}

async function assertDirectoryIdentity(
  root: string,
  directory: { path: string; identity: RootIdentity },
): Promise<{ mtimeNs: string }> {
  try {
    const lexical = await fs.lstat(directory.path, { bigint: true });
    if (lexical.isSymbolicLink() || !lexical.isDirectory()) {
      throw new WorkspaceRouteError(
        "workspace_replaced",
        "The selected folder changed while it was being read.",
        409,
        true,
      );
    }
    const canonical = await realpathPreservingDriveRoot(directory.path);
    const currentIdentity = rootIdentity(lexical);
    if (
      canonical !== directory.path ||
      !isContainedPath(root, canonical) ||
      !identitiesMatch(directory.identity, currentIdentity)
    ) {
      throw new WorkspaceRouteError(
        "workspace_replaced",
        "The selected folder changed while it was being read.",
        409,
        true,
      );
    }
    return { mtimeNs: lexical.mtimeNs.toString(10) };
  } catch (error) {
    if (error instanceof WorkspaceRouteError) {
      throw error;
    }
    throw mapFilesystemError(error);
  }
}

interface CursorBinding {
  browserId: string;
  segments: readonly string[];
  includeHidden: boolean;
  directoriesOnly: boolean;
  directory: { identity: RootIdentity };
  mtimeNs: string;
}

/** A cursor is valid only for the same hidden/folder-only view it paged. */
function cursorViewFlags(binding: CursorBinding): number {
  return (binding.includeHidden ? 1 : 0) | (binding.directoriesOnly ? 2 : 0);
}

function cursorPathDigest(segments: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(segments))
    .digest("base64url")
    .slice(0, 22);
}

function encodeCursor(
  secret: Uint8Array,
  binding: CursorBinding,
  offset: number,
): string {
  const values = [
    1,
    binding.browserId,
    cursorPathDigest(binding.segments),
    cursorViewFlags(binding),
    offset,
    binding.directory.identity.device,
    binding.directory.identity.inode,
    binding.mtimeNs,
  ] as const;
  const serialized = JSON.stringify(values);
  const signature = createHmac("sha256", secret)
    .update(serialized)
    .digest("base64url")
    .slice(0, 22);
  return Buffer.from(JSON.stringify([...values, signature]), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(
  secret: Uint8Array,
  cursor: string | undefined,
  binding: CursorBinding,
): number {
  if (!cursor) {
    return 0;
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (!Array.isArray(parsed) || parsed.length !== 9) {
      throw new Error("invalid cursor shape");
    }
    const [
      version,
      browserId,
      pathDigest,
      hidden,
      offset,
      device,
      inode,
      mtimeNs,
      signature,
    ] = parsed;
    if (
      version !== 1 ||
      browserId !== binding.browserId ||
      pathDigest !== cursorPathDigest(binding.segments) ||
      hidden !== cursorViewFlags(binding) ||
      !Number.isSafeInteger(offset) ||
      (offset as number) < 0 ||
      device !== binding.directory.identity.device ||
      inode !== binding.directory.identity.inode ||
      mtimeNs !== binding.mtimeNs ||
      typeof signature !== "string"
    ) {
      throw new Error("cursor binding mismatch");
    }
    const serialized = JSON.stringify(parsed.slice(0, 8));
    const expectedSignature = createHmac("sha256", secret)
      .update(serialized)
      .digest("base64url")
      .slice(0, 22);
    const actualBytes = Buffer.from(signature, "utf8");
    const expectedBytes = Buffer.from(expectedSignature, "utf8");
    if (
      actualBytes.length !== expectedBytes.length ||
      !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      throw new Error("cursor signature mismatch");
    }
    return offset as number;
  } catch {
    throw new WorkspaceRouteError(
      "invalid_cursor",
      "The workspace browser cursor is invalid or stale.",
      400,
      true,
    );
  }
}

async function describeEntry(
  root: string,
  directory: string,
  name: string,
): Promise<WorkspaceBrowserEntry | null> {
  const candidate = path.join(directory, name);
  try {
    const stats = await fs.lstat(candidate);
    if (stats.isSymbolicLink()) {
      try {
        const target = await realpathPreservingDriveRoot(candidate);
        return {
          name,
          kind: "symlink",
          size: null,
          readable: false,
          symlinkState: isContainedPath(root, target) ? "internal" : "external",
        };
      } catch {
        return {
          name,
          kind: "symlink",
          size: null,
          readable: false,
          symlinkState: "broken",
        };
      }
    }

    const kind = stats.isDirectory()
      ? "directory"
      : stats.isFile()
        ? "file"
        : "other";
    const requiredAccess = stats.isDirectory()
      ? fsConstants.R_OK | fsConstants.X_OK
      : fsConstants.R_OK;
    const readable = await fs
      .access(candidate, requiredAccess)
      .then(() => true)
      .catch(() => false);
    return {
      name,
      kind,
      size: stats.isFile() ? stats.size : null,
      readable,
      symlinkState: null,
    };
  } catch (error) {
    // Entries can disappear between readdir and lstat. Treat that ordinary
    // filesystem race as an omitted row, but surface permission failures.
    if (filesystemErrorCode(error) === "ENOENT") {
      return null;
    }
    throw mapFilesystemError(error);
  }
}

function trimOldestEntries<T>(map: Map<string, T>, maximum: number): void {
  while (map.size > maximum) {
    const oldest = map.keys().next().value;
    if (typeof oldest !== "string") {
      return;
    }
    map.delete(oldest);
  }
}

interface KnownLocationDefinition {
  id: WorkspaceLocationId;
  kind: WorkspaceLocation["kind"];
  name: string;
  rootName: string;
  pathLabel: string;
  resolvePath: () => Promise<string>;
}

function configuredKnownLocationResolver(
  options: WorkspaceRoutesOptions,
  id: WorkspaceLocationId,
  fallback: () => Promise<string>,
): () => Promise<string> {
  const configuredResolver = options.resolveLocationPaths?.[id];
  if (configuredResolver) {
    return configuredResolver;
  }
  const configuredPath = options.locationPaths?.[id];
  if (configuredPath !== undefined) {
    return async () => configuredPath;
  }
  return fallback;
}

function knownLocation(
  definition: KnownLocationDefinition,
  state: "unprobed" | "available",
): WorkspaceLocation {
  return {
    id: definition.id,
    name: definition.name,
    kind: definition.kind,
    state,
    pathLabel: definition.pathLabel,
  };
}

export function createWorkspaceRoutes(
  options: WorkspaceRoutesOptions = {},
): Hono {
  const now = options.now ?? Date.now;
  const capabilityTtlMs =
    options.browserCapabilityTtlMs ?? defaultBrowserCapabilityTtlMs;
  const getLegacyDesktopPath =
    options.resolveDesktopPath ??
    (options.desktopPath
      ? async () => {
          const normalized = normalizeKnownFolderCandidate(
            options.desktopPath as string,
            process.platform,
          );
          if (!normalized) {
            throw new WorkspaceRouteError(
              "workspace_unavailable",
              "The configured Desktop path must be absolute and cannot be a filesystem root.",
              500,
              false,
            );
          }
          return normalized;
        }
      : () => resolveDesktopDirectoryPath());
  const desktopPathLabel = options.desktopPathLabel ?? "Desktop";
  const defaultHomePath = async () => homedir();
  const defaultDocumentsPath = () => resolveDocumentsDirectoryPath();
  const defaultDownloadsPath = () => resolveDownloadsDirectoryPath();
  const definitions: KnownLocationDefinition[] = [
    {
      id: "desktop",
      kind: "known-folder",
      name: "Desktop",
      rootName: "Desktop",
      pathLabel:
        options.locationPathLabels?.desktop ?? desktopPathLabel,
      resolvePath: configuredKnownLocationResolver(
        options,
        "desktop",
        getLegacyDesktopPath,
      ),
    },
    {
      id: "home",
      kind: "known-folder",
      name: "Home (broad access)",
      rootName: "Home",
      pathLabel: options.locationPathLabels?.home ?? "Home",
      resolvePath: configuredKnownLocationResolver(
        options,
        "home",
        defaultHomePath,
      ),
    },
    {
      id: "documents",
      kind: "known-folder",
      name: "Documents",
      rootName: "Documents",
      pathLabel: options.locationPathLabels?.documents ?? "Documents",
      resolvePath: configuredKnownLocationResolver(
        options,
        "documents",
        defaultDocumentsPath,
      ),
    },
    {
      id: "downloads",
      kind: "known-folder",
      name: "Downloads",
      rootName: "Downloads",
      pathLabel: options.locationPathLabels?.downloads ?? "Downloads",
      resolvePath: configuredKnownLocationResolver(
        options,
        "downloads",
        defaultDownloadsPath,
      ),
    },
    {
      id: "projects",
      kind: "known-folder",
      name: "Projects",
      rootName: "Projects",
      pathLabel: options.locationPathLabels?.projects ?? "Projects",
      resolvePath: configuredKnownLocationResolver(
        options,
        "projects",
        () => resolveProjectsDirectoryPath(),
      ),
    },
  ];
  if (options.enableDrives ?? process.platform === "win32") {
    definitions.push({
      id: "drives",
      kind: "drives",
      name: "This PC",
      rootName: "This PC",
      pathLabel: "This PC",
      resolvePath: async () => {
        throw new Error("The Drives location has no single root.");
      },
    });
  }
  const listDrives = options.listDrives ?? (() => listWindowsDrives());
  const driveRoot = options.driveRoot ?? windowsDriveRoot;
  const usesDefaultKnownFolders =
    !options.locationPaths &&
    !options.resolveLocationPaths &&
    !options.resolveDesktopPath &&
    !options.desktopPath;
  const prewarmKnownFolders =
    options.prewarmKnownFolders ??
    (process.platform === "win32" && usesDefaultKnownFolders
      ? () => void resolveWindowsKnownFolders(Bun.env)
      : () => undefined);
  const listRecentWorkspaces =
    options.listRecentWorkspaces ?? listRecentSessionWorkspaces;
  const recentKeySecret = randomBytes(32);
  const recentWorkspaceKey = (cwd: string) =>
    createHmac("sha256", recentKeySecret)
      .update(process.platform === "win32" ? cwd.toLowerCase() : cwd)
      .digest("base64url")
      .slice(0, 22);
  const definitionsById = new Map(
    definitions.map((definition) => [definition.id, definition]),
  );
  const createSession = options.createSession ?? createChatSession;
  const nativeDirectoryPicker =
    options.nativeDirectoryPicker ?? createNativeDirectoryPicker();
  const authorizeNativePickerRequest =
    options.authorizeNativePickerRequest ?? isAuthenticatedWebRequest;
  const launchFolderPath = parseLaunchFolderPath(
    options.launchFolderPath === undefined
      ? Bun.env.LIGHTCODE_WEB_LAUNCH_CWD
      : options.launchFolderPath,
  );
  const resolveLaunchFolder = async () => {
    if (!launchFolderPath) {
      throw new WorkspaceRouteError(
        "workspace_unavailable",
        "Lightcode was not started from a project folder.",
        404,
        false,
      );
    }
    return resolveKnownDirectory(launchFolderPath);
  };
  const cursorSecret = randomBytes(32);
  const browserCapabilities = new Map<string, BrowserCapability>();
  const workspaceGrants = new Map<string, StoredWorkspaceGrant>();

  const getBrowserCapability = (browserId: string): BrowserCapability => {
    const capability = browserCapabilities.get(browserId);
    if (!capability || capability.expiresAtMs <= now()) {
      browserCapabilities.delete(browserId);
      throw new WorkspaceRouteError(
        "browser_capability_expired",
        capability
          ? `This folder browser expired. Open ${capability.rootName} again.`
          : "This folder browser expired. Open a location again.",
        410,
        true,
      );
    }
    return capability;
  };

  const getWorkspaceGrant = (workspaceId: string): StoredWorkspaceGrant => {
    const grant = workspaceGrants.get(workspaceId);
    if (!grant) {
      throw new WorkspaceRouteError(
        "workspace_grant_not_found",
        "The workspace grant is no longer available. Select the folder again.",
        404,
        true,
      );
    }
    return grant;
  };

  const storeWorkspaceGrant = async ({
    root,
    identity,
    name,
    pathLabel,
    request,
  }: {
    root: string;
    identity: RootIdentity;
    name: string;
    pathLabel: string;
    /** The host path is echoed only to the authenticated web client. */
    request: Request;
  }): Promise<WorkspaceGrant> => {
    await fs.access(root, fsConstants.R_OK | fsConstants.X_OK);
    const createdAt = new Date(now()).toISOString();
    const id = crypto.randomUUID();
    const grant: StoredWorkspaceGrant = {
      id,
      name,
      pathLabel,
      createdAt,
      root,
      identity,
    };
    workspaceGrants.set(id, grant);
    trimOldestEntries(workspaceGrants, maximumWorkspaceGrants);
    try {
      await assertRootIdentity(grant);
    } catch (error) {
      workspaceGrants.delete(id);
      throw error;
    }
    return workspaceGrantSchema.parse({
      id,
      name,
      pathLabel,
      ...(authorizeNativePickerRequest(request) ? { hostPath: root } : {}),
      createdAt,
    });
  };

  /**
   * Maps a browser request to the root it may touch. Folder capabilities are
   * bound to one canonical root; a Drives capability treats the first
   * segment as a drive token it listed earlier, and that drive as the root.
   */
  const resolveBrowseScope = async (
    capability: BrowserCapability,
    segments: readonly string[],
  ): Promise<BrowseScope> => {
    if (capability.kind === "folder") {
      await assertRootIdentity(capability);
      return { root: capability.root, segments, rootName: capability.rootName };
    }
    const [token, ...rest] = segments;
    if (
      !token ||
      !windowsDriveTokenPattern.test(token) ||
      !capability.driveTokens?.has(token)
    ) {
      throw new WorkspaceRouteError(
        "location_not_found",
        "That drive is not available. Open This PC again.",
        404,
        true,
      );
    }
    const root = await realpathPreservingDriveRoot(driveRoot(token)).catch((error) => {
      throw mapFilesystemError(error);
    });
    return { root, segments: rest, rootName: token };
  };

  return new Hono()
    .post(
      "/picker/open",
      zValidator("json", workspaceNativePickerRequestSchema, (result, c) => {
        if (!result.success) {
          return invalidRequestResponse(c);
        }
      }),
      async (c) => {
        if (!authorizeNativePickerRequest(c.req.raw)) {
          return c.json(
            {
              error:
                "The system folder picker is available only to an authenticated Lightcode web session.",
              code: "web_browser_required",
            },
            403,
          );
        }
        try {
          let picked;
          try {
            // The server exempts this route from its idle timeout because a
            // human is choosing; a closed tab still aborts, and an orphaned
            // dialog is killed at the cap.
            picked = await nativeDirectoryPicker.pick(
              AbortSignal.any([
                c.req.raw.signal,
                AbortSignal.timeout(nativePickerMaximumMs),
              ]),
            );
          } catch (error) {
            throw mapNativePickerError(error);
          }
          if (picked.outcome === "cancelled") {
            return c.json(
              workspaceNativePickerResponseSchema.parse({
                outcome: "cancelled",
              }),
              200,
            );
          }

          const directory = await resolveKnownDirectory(picked.directory);
          const workspace = await storeWorkspaceGrant({
            request: c.req.raw,
            ...directory,
            name: path.basename(directory.root),
            pathLabel: directory.root,
          });
          return c.json(
            workspaceNativePickerResponseSchema.parse({
              outcome: "selected",
              workspace,
            }),
            201,
          );
        } catch (error) {
          return workspaceErrorResponse(c, error);
        }
      },
    )
    .get("/launch-folder", async (c) => {
      try {
        const { root } = await resolveLaunchFolder();
        const home = await realpathPreservingDriveRoot(homedir()).catch(() => homedir());
        return c.json(
          workspaceLaunchFolderResponseSchema.parse({
            available: true,
            name: path.basename(root),
            pathLabel: root,
            broad: isContainedPath(root, home),
          }),
        );
      } catch {
        return c.json(
          workspaceLaunchFolderResponseSchema.parse({ available: false }),
        );
      }
    })
    .post(
      "/launch-folder/grant",
      zValidator(
        "json",
        workspaceLaunchFolderGrantRequestSchema,
        (result, c) => {
          if (!result.success) {
            return invalidRequestResponse(c);
          }
        },
      ),
      async (c) => {
        if (!authorizeNativePickerRequest(c.req.raw)) {
          return c.json(
            {
              error:
                "The launch folder can be opened only from an authenticated Lightcode web session.",
              code: "web_browser_required",
            },
            403,
          );
        }
        try {
          const directory = await resolveLaunchFolder();
          const workspace = await storeWorkspaceGrant({
            request: c.req.raw,
            ...directory,
            name: path.basename(directory.root),
            pathLabel: directory.root,
          });
          return c.json(
            workspaceBrowserSelectResponseSchema.parse({ workspace }),
            201,
          );
        } catch (error) {
          return workspaceErrorResponse(c, error);
        }
      },
    )
    .get("/locations", (c) => {
      prewarmKnownFolders();
      return c.json(
        workspaceLocationsResponseSchema.parse({
          locations: definitions.map((definition) =>
            knownLocation(definition, "unprobed"),
          ),
        }),
      );
    })
    .get("/recent", async (c) => {
      try {
        // Sessions may have run at a drive root; those can never be granted.
        const recent = (await listRecentWorkspaces(12))
          .filter((workspace) => !isFilesystemRootPath(workspace.cwd))
          .slice(0, 8);
        const projects = await Promise.all(
          recent.map(async (workspace) => ({
            key: recentWorkspaceKey(workspace.cwd),
            name: path.basename(workspace.cwd) || workspace.cwd,
            pathLabel: workspace.cwd,
            lastUsedAt: workspace.lastUsedAt.toISOString(),
            available: await fs
              .stat(workspace.cwd)
              .then((stats) => stats.isDirectory())
              .catch(() => false),
          })),
        );
        return c.json(workspaceRecentProjectsResponseSchema.parse({ projects }));
      } catch (error) {
        return workspaceErrorResponse(c, error);
      }
    })
    .post(
      "/recent/:key/grant",
      zValidator("param", workspaceRecentPathParamsSchema, (result, c) => {
        if (!result.success) {
          return invalidRequestResponse(c);
        }
      }),
      zValidator("json", workspaceRecentGrantRequestSchema, (result, c) => {
        if (!result.success) {
          return invalidRequestResponse(c);
        }
      }),
      async (c) => {
        if (!authorizeNativePickerRequest(c.req.raw)) {
          return c.json(
            {
              error:
                "Recent projects can be opened only from an authenticated Lightcode web session.",
              code: "web_browser_required",
            },
            403,
          );
        }
        try {
          const { key } = c.req.valid("param");
          const recent = (await listRecentWorkspaces(50)).find(
            (workspace) => recentWorkspaceKey(workspace.cwd) === key,
          );
          if (!recent) {
            throw new WorkspaceRouteError(
              "location_not_found",
              "That recent project is no longer listed. Refresh and try again.",
              404,
              false,
            );
          }
          const directory = await resolveKnownDirectory(recent.cwd);
          // A folder replaced at the same path since last use must not be
          // granted silently.
          if (
            recent.identity &&
            recent.identity.inode !== "unsupported" &&
            directory.identity.inode !== "unsupported" &&
            !identitiesMatch(recent.identity, directory.identity)
          ) {
            throw new WorkspaceRouteError(
              "workspace_replaced",
              "This folder was replaced since it was last used. Choose it again with the folder picker.",
              409,
              false,
            );
          }
          const workspace = await storeWorkspaceGrant({
            request: c.req.raw,
            ...directory,
            name: path.basename(directory.root),
            pathLabel: directory.root,
          });
          return c.json(
            workspaceBrowserSelectResponseSchema.parse({ workspace }),
            201,
          );
        } catch (error) {
          return workspaceErrorResponse(c, error);
        }
      },
    )
    .post(
      "/browser/open",
      zValidator("json", workspaceBrowserOpenRequestSchema, (result, c) => {
        if (!result.success) {
          return invalidRequestResponse(c);
        }
      }),
      async (c) => {
        try {
          const { locationId } = c.req.valid("json");
          const definition = definitionsById.get(locationId);
          if (!definition) {
            throw new WorkspaceRouteError(
              "location_not_found",
              "Workspace location not found.",
              404,
              false,
            );
          }
          if (definition.kind === "drives") {
            const browserId = crypto.randomUUID();
            const expiresAtMs = now() + capabilityTtlMs;
            const location = knownLocation(definition, "available");
            browserCapabilities.set(browserId, {
              id: browserId,
              kind: "drives",
              root: "",
              identity: { device: "drives", inode: "drives" },
              location,
              rootName: definition.rootName,
              expiresAtMs,
            });
            trimOldestEntries(browserCapabilities, maximumBrowserCapabilities);
            return c.json(
              workspaceBrowserOpenResponseSchema.parse({
                browserId,
                location,
                expiresAt: new Date(expiresAtMs).toISOString(),
              }),
              201,
            );
          }
          const discoveredPath = await definition.resolvePath();
          const safePath = normalizeKnownFolderCandidate(
            discoveredPath,
            process.platform,
          );
          if (!safePath) {
            throw new WorkspaceRouteError(
              "workspace_unavailable",
              `The resolved ${definition.rootName} location is not a safe absolute folder path.`,
              500,
              false,
            );
          }
          const resolved = await resolveKnownDirectory(safePath).catch(
            (error: unknown) => {
              if (
                error instanceof WorkspaceRouteError &&
                error.code === "workspace_missing"
              ) {
                throw new WorkspaceRouteError(
                  "location_missing",
                  definition.id === "projects"
                    ? `No Projects folder at ${safePath}. Create it, or set LIGHTCODE_PROJECTS_PATH to the folder that holds your projects.`
                    : `No ${definition.rootName} folder at ${safePath}.`,
                  404,
                  false,
                );
              }
              throw error;
            },
          );
          const browserId = crypto.randomUUID();
          const expiresAtMs = now() + capabilityTtlMs;
          const location = knownLocation(definition, "available");
          browserCapabilities.set(browserId, {
            id: browserId,
            kind: "folder",
            ...resolved,
            location,
            rootName: definition.rootName,
            expiresAtMs,
          });
          trimOldestEntries(browserCapabilities, maximumBrowserCapabilities);
          return c.json(
            workspaceBrowserOpenResponseSchema.parse({
              browserId,
              location,
              expiresAt: new Date(expiresAtMs).toISOString(),
            }),
            201,
          );
        } catch (error) {
          return workspaceErrorResponse(c, error);
        }
      },
    )
    .post(
      "/browser/:browserId/entries",
      zValidator("param", workspaceBrowserPathParamsSchema, (result, c) => {
        if (!result.success) {
          return invalidRequestResponse(c);
        }
      }),
      zValidator("json", workspaceBrowserEntriesRequestSchema, (result, c) => {
        if (!result.success) {
          return invalidRequestResponse(c);
        }
      }),
      async (c) => {
        try {
          const { browserId } = c.req.valid("param");
          const input = c.req.valid("json");
          const capability = getBrowserCapability(browserId);
          if (capability.kind === "drives" && input.segments.length === 0) {
            const drives = await listDrives();
            capability.driveTokens = new Set(
              drives.map((drive) => drive.token),
            );
            return c.json(
              workspaceBrowserEntriesResponseSchema.parse({
                browserId,
                segments: [],
                entries: drives.map((drive) => ({
                  name: drive.token,
                  kind: "directory",
                  size: null,
                  readable: drive.readable,
                  symlinkState: null,
                })),
                nextCursor: null,
                truncated: false,
              }),
            );
          }
          const scope = await resolveBrowseScope(capability, input.segments);
          const directory = await resolveDirectoryFromSegments(
            scope.root,
            scope.segments,
            scope.rootName,
          );
          const beforeRead = await assertDirectoryIdentity(
            scope.root,
            directory,
          );
          const cursorBinding: CursorBinding = {
            browserId,
            segments: input.segments,
            includeHidden: input.includeHidden,
            directoriesOnly: input.directoriesOnly,
            directory,
            mtimeNs: beforeRead.mtimeNs,
          };
          const offset = decodeCursor(
            cursorSecret,
            input.cursor,
            cursorBinding,
          );
          await options.beforeDirectoryOperation?.({
            operation: "list",
            directory: directory.path,
          });
          const describedEntries: WorkspaceBrowserEntry[] = [];
          let visibleOffset = 0;
          let truncated = false;
          const directoryHandle = await fs.opendir(directory.path);
          try {
            while (true) {
              const entry = await directoryHandle.read();
              if (!entry) {
                break;
              }
              if (!input.includeHidden && isHiddenBrowserEntry(entry)) {
                continue;
              }
              if (input.directoriesOnly && isOmittedFromFolderListing(entry)) {
                continue;
              }
              if (visibleOffset < offset) {
                visibleOffset += 1;
                continue;
              }
              if (describedEntries.length >= input.limit) {
                truncated = true;
                break;
              }
              visibleOffset += 1;
              const described = await describeEntry(
                scope.root,
                directory.path,
                entry.name,
              );
              if (described) {
                describedEntries.push(described);
              }
            }
          } finally {
            // Bun's fs.Dir.close() currently follows the callback overload at
            // runtime and returns undefined even though Node's types expose a
            // Promise overload. closeSync is portable here; reading through
            // EOF may already have closed the handle, which is harmless.
            try {
              directoryHandle.closeSync();
            } catch (error) {
              if (filesystemErrorCode(error) !== "ERR_DIR_CLOSED") {
                throw error;
              }
            }
          }
          const afterRead = await assertDirectoryIdentity(
            scope.root,
            directory,
          );
          if (afterRead.mtimeNs !== beforeRead.mtimeNs) {
            throw new WorkspaceRouteError(
              "invalid_cursor",
              "The folder changed while it was being listed. Refresh and try again.",
              409,
              true,
            );
          }
          return c.json(
            workspaceBrowserEntriesResponseSchema.parse({
              browserId,
              segments: input.segments,
              entries: describedEntries,
              nextCursor: truncated
                ? encodeCursor(cursorSecret, cursorBinding, visibleOffset)
                : null,
              truncated,
            }),
          );
        } catch (error) {
          return workspaceErrorResponse(c, error);
        }
      },
    )
    .post(
      "/browser/:browserId/select",
      zValidator("param", workspaceBrowserPathParamsSchema, (result, c) => {
        if (!result.success) {
          return invalidRequestResponse(c);
        }
      }),
      zValidator("json", workspaceBrowserSelectRequestSchema, (result, c) => {
        if (!result.success) {
          return invalidRequestResponse(c);
        }
      }),
      async (c) => {
        try {
          const { browserId } = c.req.valid("param");
          const { segments } = c.req.valid("json");
          const capability = getBrowserCapability(browserId);
          if (capability.kind === "drives" && segments.length < 2) {
            throw new WorkspaceRouteError(
              "drive_root_not_selectable",
              "A whole drive can't be a project. Open a folder inside it and choose that.",
              422,
              false,
            );
          }
          const scope = await resolveBrowseScope(capability, segments);
          const directory = await resolveDirectoryFromSegments(
            scope.root,
            scope.segments,
            scope.rootName,
          );
          await assertDirectoryIdentity(scope.root, directory);
          await options.beforeDirectoryOperation?.({
            operation: "select",
            directory: directory.path,
          });
          const name = segments.at(-1) ?? capability.rootName;
          // Drive selections already carry an unambiguous host path.
          const pathLabel =
            capability.kind === "drives"
              ? directory.path
              : [capability.location.pathLabel, ...segments].join("/");
          const workspace = await storeWorkspaceGrant({
            request: c.req.raw,
            root: directory.path,
            identity: directory.identity,
            name,
            pathLabel,
          });
          return c.json(
            workspaceBrowserSelectResponseSchema.parse({
              workspace,
            }),
            201,
          );
        } catch (error) {
          return workspaceErrorResponse(c, error);
        }
      },
    )
    .post(
      "/:workspaceId/sessions",
      zValidator("param", workspaceSessionPathParamsSchema, (result, c) => {
        if (!result.success) {
          return invalidRequestResponse(c);
        }
      }),
      zValidator("json", workspaceSessionCreateRequestSchema, (result, c) => {
        if (!result.success) {
          return invalidRequestResponse(c);
        }
      }),
      async (c) => {
        try {
          const { workspaceId } = c.req.valid("param");
          const body = c.req.valid("json");
          const grant = getWorkspaceGrant(workspaceId);
          await assertRootIdentity(grant);
          return c.json(
            sessionCreateResponseSchema.parse(
              await createSession({
                cwd: grant.root,
                expectedWorkspaceIdentity: grant.identity,
                mode:
                  body.mode ?? lightcodeConfigResult.config.defaultMode,
                permissionMode:
                  body.permissionMode ??
                  lightcodeConfigResult.config.permissionMode ??
                  null,
                model: chatModelId,
                title: body.title,
              }),
            ),
            201,
          );
        } catch (error) {
          return workspaceErrorResponse(c, error);
        }
      },
    );
}

export const workspaceRoutes = createWorkspaceRoutes();
