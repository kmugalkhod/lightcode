import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireServerInstanceLock,
  getDatabaseInstanceLockPath,
  resolveCanonicalDatabaseLockIdentity,
  ServerInstanceLockError,
} from "./server-instance-lock";

const temporaryDirectories: string[] = [];
const childProcesses: Array<ReturnType<typeof Bun.spawn>> = [];

async function makeDataDir() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "lightcode-lock-test-"));
  temporaryDirectories.push(dataDir);
  return dataDir;
}

function isolatedLockOptions(dataDir: string) {
  return {
    dataDir,
    databaseUrl: pathToFileURL(path.join(dataDir, "test-lightcode.db")).href,
    databaseLockRoot: path.join(dataDir, "database-lock-root"),
  };
}

async function waitForFile(filePath: string, child: ReturnType<typeof Bun.spawn>) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await access(filePath);
      return;
    } catch {
      if (child.exitCode !== null) {
        const stderr =
          child.stderr instanceof ReadableStream
            ? await new Response(child.stderr).text()
            : "";
        throw new Error(`Lock-holder child exited early: ${stderr}`);
      }
      await Bun.sleep(10);
    }
  }
  throw new Error("Timed out waiting for the lock-holder child.");
}

afterEach(async () => {
  await Promise.all(
    childProcesses.splice(0).map(async (child) => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited.catch(() => undefined);
    }),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("server instance lock", () => {
  test("rejects another server while the recorded PID is alive", async () => {
    const dataDir = await makeDataDir();
    const lockOptions = isolatedLockOptions(dataDir);
    const first = await acquireServerInstanceLock(lockOptions);

    try {
      const error = await acquireServerInstanceLock(lockOptions).catch(
        (caught) => caught,
      );
      expect(error).toBeInstanceOf(ServerInstanceLockError);
      expect(error).toMatchObject({
        code: "server_already_running",
        ownerPid: process.pid,
        lockPath: first.databaseLockPath,
      });
      expect(String(error)).toContain(`PID ${process.pid}`);
    } finally {
      expect(await first.release()).toBe(true);
    }
  });

  test("reuses an unlocked stale lease and secures runtime permissions", async () => {
    const dataDir = await makeDataDir();
    const stalePid = 2_147_483_000;
    const runtimeDirectory = path.join(dataDir, "runtime");
    const stale = await acquireServerInstanceLock({
      ...isolatedLockOptions(dataDir),
      pid: stalePid,
      ownerToken: "stale-owner-token-0001",
    });
    const lockPath = stale.lockPath;
    expect(await stale.release()).toBe(true);
    await chmod(runtimeDirectory, 0o755);

    const acquired = await acquireServerInstanceLock({
      ...isolatedLockOptions(dataDir),
      isProcessAlive: (pid) => pid !== stalePid,
    });

    try {
      const record = JSON.parse(await readFile(`${lockPath}.owner`, "utf8"));
      expect(record.pid).toBe(process.pid);
      expect(record.ownerToken).not.toBe("stale-owner-token-0001");
      if (process.platform !== "win32") {
        expect((await lstat(runtimeDirectory)).mode & 0o777).toBe(0o700);
        expect((await lstat(lockPath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      expect(await acquired.release()).toBe(true);
    }
  });

  test.skipIf(process.platform === "win32")(
    "release never removes a replacement owned by another server",
    async () => {
      const dataDir = await makeDataDir();
      const acquired = await acquireServerInstanceLock(
        isolatedLockOptions(dataDir),
      );
      const displacedPath = `${acquired.lockPath}.displaced`;
      await rename(acquired.lockPath, displacedPath);
      const replacement = "replacement owned by another process\n";
      await writeFile(acquired.lockPath, replacement, { mode: 0o600 });

      expect(await acquired.release()).toBe(true);
      expect(await readFile(acquired.lockPath, "utf8")).toBe(replacement);
      expect(await acquired.release()).toBe(false);
    },
  );

  test("concurrent acquisition has exactly one winner", async () => {
    const dataDir = await makeDataDir();
    const stalePid = 2_147_483_000;
    const stale = await acquireServerInstanceLock({
      ...isolatedLockOptions(dataDir),
      pid: stalePid,
      ownerToken: "raced-stale-owner-token-0001",
    });
    expect(await stale.release()).toBe(true);
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        acquireServerInstanceLock({
          ...isolatedLockOptions(dataDir),
          ownerToken: `race-owner-token-${String(index).padStart(4, "0")}`,
          isProcessAlive: (pid) => pid !== stalePid,
        }),
      ),
    );
    const winners = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<
        Awaited<ReturnType<typeof acquireServerInstanceLock>>
      > => attempt.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected",
    );

    expect(winners).toHaveLength(1);
    expect(rejected).toHaveLength(11);
    for (const attempt of rejected) {
      expect(attempt.reason).toMatchObject({ code: "server_already_running" });
    }
    expect(await winners[0]!.value.release()).toBe(true);
  });

  test("different LIGHTCODE_HOME values cannot share one canonical database", async () => {
    const testRoot = await makeDataDir();
    const firstHome = path.join(testRoot, "home-one");
    const secondHome = path.join(testRoot, "home-two");
    const storeDirectory = path.join(testRoot, "store");
    const aliasDirectory = path.join(testRoot, "store-alias");
    const databaseLockRoot = path.join(testRoot, "shared-database-locks");
    await Promise.all([
      mkdir(firstHome, { mode: 0o700 }),
      mkdir(secondHome, { mode: 0o700 }),
      mkdir(storeDirectory, { mode: 0o700 }),
    ]);

    let secondDatabasePath = path.join(storeDirectory, "shared.db");
    if (process.platform !== "win32") {
      await symlink(storeDirectory, aliasDirectory, "dir");
      secondDatabasePath = path.join(aliasDirectory, "shared.db");
    }

    const firstDatabaseUrl = pathToFileURL(
      path.join(storeDirectory, "shared.db"),
    ).href;
    const secondDatabaseUrl = pathToFileURL(secondDatabasePath).href;
    expect(
      await getDatabaseInstanceLockPath({ databaseUrl: firstDatabaseUrl }),
    ).toBe(
      await getDatabaseInstanceLockPath({ databaseUrl: secondDatabaseUrl }),
    );

    const first = await acquireServerInstanceLock({
      dataDir: firstHome,
      databaseUrl: firstDatabaseUrl,
      databaseLockRoot,
    });

    try {
      const error = await acquireServerInstanceLock({
        dataDir: secondHome,
        databaseUrl: secondDatabaseUrl,
        databaseLockRoot,
      }).catch((caught) => caught);

      expect(error).toBeInstanceOf(ServerInstanceLockError);
      expect(error).toMatchObject({
        code: "server_already_running",
        ownerPid: process.pid,
        lockPath: first.databaseLockPath,
      });
      expect(first.databaseLockPath).not.toBe(first.lockPath);
    } finally {
      expect(await first.release()).toBe(true);
    }
  });

  test.skipIf(process.platform === "win32")(
    "a cross-process OS lease recovers after SIGKILL",
    async () => {
      const testRoot = await makeDataDir();
      const firstHome = path.join(testRoot, "child-home");
      const secondHome = path.join(testRoot, "parent-home");
      const storeDirectory = path.join(testRoot, "store");
      const databaseLockRoot = path.join(testRoot, "database-locks");
      const readyFile = path.join(testRoot, "child-ready");
      await Promise.all([
        mkdir(firstHome, { mode: 0o700 }),
        mkdir(secondHome, { mode: 0o700 }),
        mkdir(storeDirectory, { mode: 0o700 }),
      ]);
      const databaseUrl = pathToFileURL(
        path.join(storeDirectory, "shared.db"),
      ).href;
      const moduleUrl = new URL("./server-instance-lock.ts", import.meta.url).href;
      const childScript = `
        const { acquireServerInstanceLock } = await import(${JSON.stringify(moduleUrl)});
        await acquireServerInstanceLock({
          dataDir: process.env.TEST_DATA_DIR,
          databaseUrl: process.env.TEST_DATABASE_URL,
          databaseLockRoot: process.env.TEST_DATABASE_LOCK_ROOT,
        });
        await Bun.write(process.env.TEST_READY_FILE, "ready");
        setInterval(() => {}, 1000);
      `;
      const child = Bun.spawn([process.execPath, "-e", childScript], {
        cwd: process.cwd(),
        stdout: "ignore",
        stderr: "pipe",
        env: {
          ...process.env,
          TEST_DATA_DIR: firstHome,
          TEST_DATABASE_URL: databaseUrl,
          TEST_DATABASE_LOCK_ROOT: databaseLockRoot,
          TEST_READY_FILE: readyFile,
        },
      });
      childProcesses.push(child);
      await waitForFile(readyFile, child);

      const whileAlive = await acquireServerInstanceLock({
        dataDir: secondHome,
        databaseUrl,
        databaseLockRoot,
      }).catch((caught) => caught);
      expect(whileAlive).toMatchObject({
        code: "server_already_running",
        ownerPid: child.pid,
      });

      child.kill("SIGKILL");
      await child.exited;
      const afterCrash = await acquireServerInstanceLock({
        dataDir: secondHome,
        databaseUrl,
        databaseLockRoot,
      });
      expect(await afterCrash.release()).toBe(true);
    },
    10_000,
  );

  test("rejects remote stores and never keys their credentials", async () => {
    const dataDir = await makeDataDir();
    const firstUrl =
      "libsql://alice:secret-one@example.test/team?authToken=first";
    const secondUrl =
      "libsql://bob:secret-two@example.test/team?authToken=second";
    expect(await resolveCanonicalDatabaseLockIdentity(firstUrl)).toBe(
      await resolveCanonicalDatabaseLockIdentity(secondUrl),
    );

    const error = await acquireServerInstanceLock({
      dataDir,
      databaseUrl: firstUrl,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ServerInstanceLockError);
    expect(error).toMatchObject({ code: "server_lock_unsafe" });
    expect(String(error)).toContain("Remote LIGHTCODE_DATABASE_URL");
    expect(String(error)).not.toContain("secret-one");
  });
});
