import {
  createLogger,
  enableFileLogSink,
  getErrorMessage,
} from "@lightcode/shared";
import type { app as appInstance } from "./app";

export type AppType = typeof appInstance;

const logger = createLogger("server");
const httpIdleTimeoutSeconds = 30;
const shutdownForceExitMs = 5_000;

function isChatStreamingRoute(request: Request) {
  if (request.method !== "POST") {
    return false;
  }

  const pathname = new URL(request.url).pathname;
  return /^\/sessions\/[^/]+\/chat$/.test(pathname);
}

async function startServer() {
  const logDirectory = enableFileLogSink(Bun.env);
  if (logDirectory) {
    logger.info("file_log_sink_enabled", { directory: logDirectory });
  }

  // Uncommon default on purpose: 3000 is what scaffolded user apps (Next.js,
  // CRA, Express) grab, and sharing it breaks the CLI<->server channel.
  const port = Number(Bun.env.PORT ?? 4983);
  // Bind loopback-only by default: the server is a local companion process
  // with no authentication and must not be reachable from the network.
  const hostname = Bun.env.LIGHTCODE_HOST ?? "127.0.0.1";

  let app: AppType;
  try {
    ({ app } = await import("./app"));
  } catch (error) {
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
    const forceExitTimer = setTimeout(() => {
      server.stop(true);
      process.exit(0);
    }, shutdownForceExitMs);
    forceExitTimer.unref();

    server.stop();
    try {
      const { prisma } = await import("./lib/prisma-client");
      await prisma.$disconnect();
    } catch {
      // Database may never have been touched; nothing to release.
    }

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
