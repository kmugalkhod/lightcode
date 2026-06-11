import { createLogger, getErrorMessage } from "@lightcode/shared";
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
  const port = Number(Bun.env.PORT ?? 3000);
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

  const server = Bun.serve({
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

  console.log(`Server listening on http://${hostname}:${port}`);
}

if (import.meta.main) {
  await startServer();
}
