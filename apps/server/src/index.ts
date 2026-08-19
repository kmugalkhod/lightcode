import {
  createLogger,
  enableFileLogSink,
  getErrorMessage,
} from "@lightcode/shared";
import type { app as appInstance } from "./app";
import {
  acquireServerInstanceLock,
  ServerInstanceLockError,
  type ServerInstanceLock,
} from "./lib/server-instance-lock";
import { isLoopbackBindHost } from "./lib/server-bind-policy";

export type AppType = typeof appInstance;

const logger = createLogger("server");
const httpIdleTimeoutSeconds = 30;
const shutdownForceExitMs = 5_000;

function isChatStreamingRoute(request: Request) {
  if (request.method !== "POST") {
    return false;
  }

  const pathname = new URL(request.url).pathname;
  return /^\/sessions\/[^/]+\/(?:chat|turns)$/.test(pathname);
}

function serverLockFailureMessage(error: unknown): string {
  if (
    error instanceof ServerInstanceLockError &&
    error.code === "server_already_running"
  ) {
    return [
      "",
      "Lightcode is already running:",
      `  ${error.message}`,
      "",
      "Lightcode currently supports one CLI or browser server per data",
      "directory. Stop the existing Lightcode session, then try again.",
      `Lock: ${error.lockPath}`,
      "",
    ].join("\n");
  }

  if (error instanceof ServerInstanceLockError) {
    return [
      "",
      "Lightcode could not safely claim its local data directory:",
      `  ${error.message}`,
      "",
      "Do not remove the lock while another Lightcode process is running.",
      `Lock: ${error.lockPath}`,
      "",
    ].join("\n");
  }

  return [
    "",
    "Lightcode could not claim its local data directory:",
    `  ${getErrorMessage(error)}`,
    "",
  ].join("\n");
}

async function releaseServerLock(
  instanceLock: ServerInstanceLock,
  reason: string,
) {
  try {
    const released = await instanceLock.release();
    if (!released) {
      logger.warn("server_lock_release_skipped", {
        reason,
        lockPath: instanceLock.lockPath,
      });
    }
  } catch (error) {
    logger.error("server_lock_release_failed", {
      reason,
      lockPath: instanceLock.lockPath,
      error: getErrorMessage(error),
    });
  }
}

async function startServer() {
  const logDirectory = enableFileLogSink(Bun.env);
  if (logDirectory) {
    logger.info("file_log_sink_enabled", { directory: logDirectory });
  }

  // Uncommon default on purpose: 3000 is what scaffolded user apps (Next.js,
  // CRA, Express) grab, and sharing it breaks the CLI<->server channel.
  const port = Number(Bun.env.PORT ?? 4983);
  // Bind loopback-only: this high-privilege local API can read and change a
  // selected workspace and is never exposed on a LAN interface.
  const hostname = Bun.env.LIGHTCODE_HOST ?? "127.0.0.1";
  if (!isLoopbackBindHost(hostname)) {
    process.stderr.write(
      [
        "",
        `Lightcode refused the non-loopback bind address: ${hostname}`,
        "",
        "The local agent API can read and change project files, so this",
        "release only binds to 127.x.x.x or ::1.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  let instanceLock: ServerInstanceLock;
  try {
    // Claim the persisted store before importing application modules or
    // recovering interrupted runs. This prevents a CLI and browser server
    // from independently repairing/mutating the same active-run records.
    instanceLock = await acquireServerInstanceLock();
  } catch (error) {
    process.stderr.write(serverLockFailureMessage(error));
    process.exit(1);
  }

  let app: AppType;
  try {
    ({ app } = await import("./app"));
  } catch (error) {
    await releaseServerLock(instanceLock, "app-import-failure");
    process.stderr.write(
      [
        "",
        "Lightcode server failed to start:",
        `  ${getErrorMessage(error)}`,
        "",
        "Fix ~/.lightcode/settings.json, .lightcode/settings.json, or the",
        "LIGHTCODE_* environment variables and restart.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  // Best-effort: enrich the configured OpenRouter model with live catalog
  // metadata (context window). Never blocks startup.
  void import("./lib/runtime-config")
    .then((runtime) => runtime.initializeModelCapabilities())
    .catch((error) => {
      logger.warn("model_capability_init_failed", {
        error: getErrorMessage(error),
      });
    });

  // Best-effort: when the headroom compressing-proxy facility is enabled, probe
  // it and fail open to the real provider if it is unreachable. Never blocks
  // startup or chat requests.
  void import("./lib/headroom-proxy")
    .then((headroom) => headroom.ensureHeadroomRouting())
    .catch((error) => {
      logger.warn("headroom_init_failed", {
        error: getErrorMessage(error),
      });
    });

  try {
    const { recoverInterruptedChatRuns } = await import(
      "./lib/chat-run-store"
    );
    const recoveredRuns = await recoverInterruptedChatRuns();
    if (recoveredRuns > 0) {
      logger.warn("interrupted_chat_runs_recovered", { count: recoveredRuns });
    }
  } catch (error) {
    await releaseServerLock(instanceLock, "run-recovery-failure");
    process.stderr.write(
      [
        "",
        "Lightcode could not initialize its local session store:",
        `  ${getErrorMessage(error)}`,
        "",
        "No server was started and the server lock was released.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      idleTimeout: httpIdleTimeoutSeconds,
      port,
      hostname,
      async fetch(request, bunServer) {
        if (isChatStreamingRoute(request)) {
          bunServer.timeout(request, 0);
        }

        return app.fetch(request);
      },
    });
  } catch (error) {
    await releaseServerLock(instanceLock, "bind-failure");
    process.stderr.write(
      [
        "",
        `Lightcode server could not bind ${hostname}:${port}:`,
        `  ${getErrorMessage(error)}`,
        "",
        "Another process is likely using this port. Set PORT (or",
        "LIGHTCODE_API_URL for the CLI) to a free port and restart.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("server_shutdown", { signal });

    // Force-exit if in-flight streams keep the server alive too long.
    const forceExitTimer = setTimeout(async () => {
      await server.stop(true);
      await releaseServerLock(instanceLock, "forced-shutdown");
      process.exit(0);
    }, shutdownForceExitMs);
    forceExitTimer.unref();

    await server.stop();
    try {
      const { prisma } = await import("./lib/prisma-client");
      await prisma.$disconnect();
    } catch {
      // Database may never have been touched; nothing to release.
    }

    await releaseServerLock(instanceLock, "graceful-shutdown");

    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Parent-death watchdog: when the CLI that launched us is gone, exit too.
  // process.on("exit") in the CLI cannot cover SIGKILL or terminal closes, and
  // on macOS the spawned server otherwise survives — leaving a stale server on
  // the port that a later run reuses with frozen config.
  const parentPid = Number(Bun.env.LIGHTCODE_PARENT_PID);
  if (Number.isInteger(parentPid) && parentPid > 0) {
    const parentWatch = setInterval(() => {
      try {
        // Signal 0 performs existence/permission checks without delivering one.
        process.kill(parentPid, 0);
      } catch {
        void shutdown("parent-exit");
      }
    }, 2_000);
    parentWatch.unref();
  }

  console.log(`Server listening on http://${hostname}:${port}`);
}

if (import.meta.main) {
  await startServer();
}
