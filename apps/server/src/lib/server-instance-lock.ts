import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  filePathFromDatabaseUrl,
  resolveDatabaseUrl,
} from "@lightcode/db/local-database";
import { getErrorMessage, getLightcodeDataDir } from "@lightcode/shared";

const lockFileName = "server.lock";
const ownerFileSuffix = ".owner";
const lockRecordVersion = 1;
const maximumOwnerFileBytes = 4_096;

interface LockOwnerRecord {
  version: typeof lockRecordVersion;
  pid: number;
  ownerToken: string;
  createdAt: string;
}

interface SingleServerInstanceLock {
  readonly dataDir: string;
  readonly lockPath: string;
  readonly ownerPid: number;
  release(): Promise<boolean>;
}

interface AcquireSingleLockOptions {
  dataDir: string;
  pid: number;
  ownerToken: string;
  createdAt: string;
  isProcessAlive: (pid: number) => boolean;
  resourceDescription: string;
}

interface DatabaseLockTarget {
  root: string;
  dataDir: string;
  lockPath: string;
}

export type ServerInstanceLockErrorCode =
  | "server_already_running"
  | "server_lock_invalid"
  | "server_lock_unsafe";

export class ServerInstanceLockError extends Error {
  readonly code: ServerInstanceLockErrorCode;
  readonly lockPath: string;
  readonly ownerPid?: number;

  constructor(options: {
    code: ServerInstanceLockErrorCode;
    message: string;
    lockPath: string;
    ownerPid?: number;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "ServerInstanceLockError";
    this.code = options.code;
    this.lockPath = options.lockPath;
    this.ownerPid = options.ownerPid;
  }
}

export interface ServerInstanceLock {
  readonly dataDir: string;
  readonly lockPath: string;
  /** Stable, hashed lock shared by processes targeting the same database. */
  readonly databaseLockPath: string;
  readonly ownerPid: number;
  /** Releases only the OS leases held by this acquisition. */
  release(): Promise<boolean>;
}

export interface AcquireServerInstanceLockOptions {
  dataDir?: string;
  /** Defaults to the resolved LIGHTCODE_DATABASE_URL/PATH configuration. */
  databaseUrl?: string;
  /** Primarily useful for isolated tests. */
  databaseLockRoot?: string;
  pid?: number;
  ownerToken?: string;
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isFileError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function isMissingFileError(error: unknown): boolean {
  return isFileError(error, "ENOENT");
}

function isAlreadyExistsError(error: unknown): boolean {
  return isFileError(error, "EEXIST");
}

function isSqliteBusyError(error: unknown): boolean {
  const code =
    error instanceof Error && "code" in error
      ? String((error as Error & { code?: unknown }).code)
      : "";
  const message = getErrorMessage(error).toLowerCase();
  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    message.includes("database is locked") ||
    message.includes("database table is locked")
  );
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isFileError(error, "ESRCH")) {
      return false;
    }
    // EPERM means that a process owns the PID. Unknown failures fail closed.
    return true;
  }
}

async function canonicalizePotentialFilePath(filePath: string): Promise<string> {
  const absolutePath = path.resolve(filePath);
  try {
    const resolved = await realpath(absolutePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  // The database may not exist before startup. Resolve its nearest existing
  // ancestor so aliases through existing symlinked directories still converge.
  const missingSegments: string[] = [];
  let existingAncestor = absolutePath;
  while (true) {
    missingSegments.unshift(path.basename(existingAncestor));
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error(`No existing ancestor found for ${absolutePath}.`);
    }
    existingAncestor = parent;
    try {
      const resolvedAncestor = await realpath(existingAncestor);
      const resolved = path.join(resolvedAncestor, ...missingSegments);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }
}

function canonicalizeRemoteDatabaseUrl(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  // Authentication material must neither leak into the lock path nor let two
  // credentials for the same endpoint evade each other's local lease. Ignoring
  // all query options is deliberately conservative: it may over-lock, never
  // under-lock, remote stores sharing an endpoint path.
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

async function resolveCanonicalDatabaseLockTarget(
  databaseUrl: string,
): Promise<{ identity: string; canonicalFilePath: string | null }> {
  const databasePath = filePathFromDatabaseUrl(databaseUrl);
  if (databasePath) {
    const canonicalFilePath = await canonicalizePotentialFilePath(databasePath);
    return {
      identity: `file:${canonicalFilePath}`,
      canonicalFilePath,
    };
  }
  return {
    identity: `remote:${canonicalizeRemoteDatabaseUrl(databaseUrl)}`,
    canonicalFilePath: null,
  };
}

export async function resolveCanonicalDatabaseLockIdentity(
  databaseUrl = resolveDatabaseUrl(),
): Promise<string> {
  return (await resolveCanonicalDatabaseLockTarget(databaseUrl)).identity;
}

function defaultDatabaseLockRoot(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    return path.join(
      localAppData || path.join(homedir(), "AppData", "Local"),
      "Lightcode",
      "database-locks",
    );
  }

  const uid = process.getuid?.();
  const userDiscriminator =
    uid === undefined
      ? `home-${sha256(path.resolve(homedir())).slice(0, 16)}`
      : `uid-${uid}`;
  return path.join("/tmp", `.lightcode-${userDiscriminator}-database-locks`);
}

async function resolveDatabaseLockTarget(options: {
  databaseUrl?: string;
  databaseLockRoot?: string;
}): Promise<DatabaseLockTarget> {
  const databaseUrl = options.databaseUrl ?? resolveDatabaseUrl();
  const canonicalTarget = await resolveCanonicalDatabaseLockTarget(
    databaseUrl,
  );
  if (!canonicalTarget.canonicalFilePath) {
    const diagnosticLockPath = getServerInstanceLockPath(
      options.databaseLockRoot ?? getLightcodeDataDir(),
    );
    throw new ServerInstanceLockError({
      code: "server_lock_unsafe",
      lockPath: diagnosticLockPath,
      message:
        "Remote LIGHTCODE_DATABASE_URL values are not supported by the " +
        "single-server safety lock. Use LIGHTCODE_DATABASE_PATH or a file: URL.",
    });
  }
  const identityHash = sha256(canonicalTarget.identity);
  const root = path.resolve(
    options.databaseLockRoot ?? defaultDatabaseLockRoot(),
  );
  const dataDir = path.join(root, identityHash);
  return {
    root,
    dataDir,
    lockPath: getServerInstanceLockPath(dataDir),
  };
}

export async function getDatabaseInstanceLockPath(options: {
  databaseUrl?: string;
  databaseLockRoot?: string;
} = {}): Promise<string> {
  return (await resolveDatabaseLockTarget(options)).lockPath;
}

async function ensureSecureDirectory(options: {
  directory: string;
  lockPath: string;
  description: string;
}): Promise<void> {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(options.directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ServerInstanceLockError({
      code: "server_lock_unsafe",
      lockPath: options.lockPath,
      message: `Lightcode's ${options.description} is not a real directory: ${options.directory}`,
    });
  }
  if (process.platform === "win32") {
    return;
  }

  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new ServerInstanceLockError({
      code: "server_lock_unsafe",
      lockPath: options.lockPath,
      message: `Lightcode's ${options.description} is owned by another user: ${options.directory}`,
    });
  }
  if ((stat.mode & 0o777) !== 0o700) {
    await chmod(options.directory, 0o700);
  }

  const securedStat = await lstat(options.directory);
  if (
    securedStat.isSymbolicLink() ||
    !securedStat.isDirectory() ||
    securedStat.dev !== stat.dev ||
    securedStat.ino !== stat.ino ||
    (securedStat.mode & 0o777) !== 0o700
  ) {
    throw new ServerInstanceLockError({
      code: "server_lock_unsafe",
      lockPath: options.lockPath,
      message: `Lightcode could not secure its ${options.description}: ${options.directory}`,
    });
  }
}

async function ensureSecureRuntimeDirectory(dataDir: string): Promise<string> {
  const runtimeDirectory = path.join(dataDir, "runtime");
  await ensureSecureDirectory({
    directory: runtimeDirectory,
    lockPath: path.join(runtimeDirectory, lockFileName),
    description: "runtime directory",
  });
  return runtimeDirectory;
}

async function preparePersistentLockFile(lockPath: string): Promise<void> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(
      lockPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        noFollow,
      0o600,
    );
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
    handle = await open(lockPath, constants.O_RDWR | noFollow);
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new ServerInstanceLockError({
        code: "server_lock_unsafe",
        lockPath,
        message: `The Lightcode server lock is not a regular file: ${lockPath}`,
      });
    }
    if (process.platform !== "win32") {
      const currentUid = process.getuid?.();
      if (currentUid !== undefined && stat.uid !== currentUid) {
        throw new ServerInstanceLockError({
          code: "server_lock_unsafe",
          lockPath,
          message: `The Lightcode server lock is owned by another user: ${lockPath}`,
        });
      }
      if ((stat.mode & 0o077) !== 0) {
        throw new ServerInstanceLockError({
          code: "server_lock_unsafe",
          lockPath,
          message: `The Lightcode server lock is accessible by other users: ${lockPath}`,
        });
      }
      await handle.chmod(0o600);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseOwnerRecord(value: string): LockOwnerRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<LockOwnerRecord>;
    if (
      parsed.version !== lockRecordVersion ||
      !Number.isSafeInteger(parsed.pid) ||
      Number(parsed.pid) <= 0 ||
      typeof parsed.ownerToken !== "string" ||
      parsed.ownerToken.length < 16 ||
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt))
    ) {
      return null;
    }
    return {
      version: lockRecordVersion,
      pid: Number(parsed.pid),
      ownerToken: parsed.ownerToken,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

async function readOwnerRecord(lockPath: string): Promise<LockOwnerRecord | null> {
  const ownerPath = `${lockPath}${ownerFileSuffix}`;
  try {
    const stat = await lstat(ownerPath);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size > maximumOwnerFileBytes
    ) {
      return null;
    }
    return parseOwnerRecord(await readFile(ownerPath, "utf8"));
  } catch {
    return null;
  }
}

async function writeOwnerRecord(
  lockPath: string,
  record: LockOwnerRecord,
): Promise<void> {
  const ownerPath = `${lockPath}${ownerFileSuffix}`;
  const candidatePath = `${ownerPath}.${randomUUID()}.tmp`;
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(
    candidatePath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      noFollow,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(candidatePath, ownerPath);
  } finally {
    await unlink(candidatePath).catch(() => undefined);
  }
}

async function acquireSingleLock(
  options: AcquireSingleLockOptions,
): Promise<SingleServerInstanceLock> {
  const dataDir = path.resolve(options.dataDir);
  let runtimeDirectory: string;
  try {
    runtimeDirectory = await ensureSecureRuntimeDirectory(dataDir);
  } catch (error) {
    if (error instanceof ServerInstanceLockError) {
      throw error;
    }
    const lockPath = getServerInstanceLockPath(dataDir);
    throw new ServerInstanceLockError({
      code: "server_lock_unsafe",
      lockPath,
      message: `Lightcode could not secure its runtime directory at ${path.dirname(lockPath)}: ${getErrorMessage(error)}`,
      cause: error,
    });
  }

  const lockPath = path.join(runtimeDirectory, lockFileName);
  try {
    await preparePersistentLockFile(lockPath);
  } catch (error) {
    if (error instanceof ServerInstanceLockError) {
      throw error;
    }
    throw new ServerInstanceLockError({
      code: "server_lock_unsafe",
      lockPath,
      message: `Lightcode could not prepare its server lock at ${lockPath}: ${getErrorMessage(error)}`,
      cause: error,
    });
  }

  const database = new Database(lockPath, { create: false, strict: true });
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch (error) {
    database.close();
    if (isSqliteBusyError(error)) {
      const owner = await readOwnerRecord(lockPath);
      const liveOwner = owner && options.isProcessAlive(owner.pid) ? owner : null;
      throw new ServerInstanceLockError({
        code: "server_already_running",
        lockPath,
        ownerPid: liveOwner?.pid,
        message: liveOwner
          ? `Another Lightcode server (PID ${liveOwner.pid}) is already using ${options.resourceDescription}.`
          : `Another Lightcode server is already using ${options.resourceDescription}.`,
        cause: error,
      });
    }
    throw new ServerInstanceLockError({
      code: "server_lock_invalid",
      lockPath,
      message: `Lightcode could not open its server lock at ${lockPath}: ${getErrorMessage(error)}`,
      cause: error,
    });
  }

  try {
    await writeOwnerRecord(lockPath, {
      version: lockRecordVersion,
      pid: options.pid,
      ownerToken: options.ownerToken,
      createdAt: options.createdAt,
    });
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } finally {
      database.close();
    }
    throw new ServerInstanceLockError({
      code: "server_lock_unsafe",
      lockPath,
      message: `Lightcode acquired but could not record ownership of ${lockPath}: ${getErrorMessage(error)}`,
      cause: error,
    });
  }

  let released = false;
  return {
    dataDir,
    lockPath,
    ownerPid: options.pid,
    async release() {
      if (released) {
        return false;
      }
      released = true;
      try {
        database.exec("ROLLBACK;");
        return true;
      } finally {
        // SQLite ties the lease to this exact connection. Closing it never
        // deletes or mutates whatever pathname may currently name lockPath.
        database.close();
      }
    },
  };
}

export function getServerInstanceLockPath(
  dataDir = getLightcodeDataDir(),
): string {
  return path.join(path.resolve(dataDir), "runtime", lockFileName);
}

export async function acquireServerInstanceLock(
  options: AcquireServerInstanceLockOptions = {},
): Promise<ServerInstanceLock> {
  const dataDir = path.resolve(options.dataDir ?? getLightcodeDataDir());
  const pid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError("Server lock PID must be a positive safe integer.");
  }
  const ownerToken = options.ownerToken ?? randomUUID();
  if (ownerToken.length < 16) {
    throw new TypeError("Server lock owner token must be at least 16 characters.");
  }

  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const databaseTarget = await resolveDatabaseLockTarget({
    databaseUrl: options.databaseUrl,
    databaseLockRoot: options.databaseLockRoot,
  });
  await ensureSecureDirectory({
    directory: databaseTarget.root,
    lockPath: databaseTarget.lockPath,
    description: "database lock directory",
  });

  // Database identity is acquired first everywhere, preventing lock-order
  // deadlocks when homes and database overrides are mixed.
  const databaseLock = await acquireSingleLock({
    dataDir: databaseTarget.dataDir,
    pid,
    ownerToken: `${ownerToken}-database`,
    createdAt,
    isProcessAlive,
    resourceDescription: "the same Lightcode session database",
  });

  let dataDirectoryLock: SingleServerInstanceLock;
  try {
    dataDirectoryLock = await acquireSingleLock({
      dataDir,
      pid,
      ownerToken: `${ownerToken}-data-directory`,
      createdAt,
      isProcessAlive,
      resourceDescription: `the Lightcode data directory at ${dataDir}`,
    });
  } catch (error) {
    await databaseLock.release().catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    dataDir,
    lockPath: dataDirectoryLock.lockPath,
    databaseLockPath: databaseLock.lockPath,
    ownerPid: pid,
    async release() {
      if (released) {
        return false;
      }
      released = true;

      let dataDirectoryReleased = false;
      let databaseReleased = false;
      let firstError: unknown;
      try {
        dataDirectoryReleased = await dataDirectoryLock.release();
      } catch (error) {
        firstError = error;
      }
      try {
        databaseReleased = await databaseLock.release();
      } catch (error) {
        firstError ??= error;
      }
      if (firstError) {
        throw firstError;
      }
      return dataDirectoryReleased && databaseReleased;
    },
  };
}
