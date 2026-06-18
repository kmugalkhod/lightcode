import { existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiBaseUrl } from "./api-base-url";

export interface ServerLaunchResult {
  url: string;
  /** Child process when this CLI started the server; null if it was already up. */
  ownedProcess: ReturnType<typeof Bun.spawn> | null;
  /** Fatal launch problem the user must resolve (e.g. foreign port owner). */
  error?: string;
}

let currentOwnedProcess: ReturnType<typeof Bun.spawn> | null = null;

export function getOwnedServerProcess(): ReturnType<typeof Bun.spawn> | null {
  return currentOwnedProcess;
}

/**
 * Restarts the CLI-owned server so it picks up new config/credentials.
 * Returns false when this CLI does not own the server process (externally
 * started servers must be restarted by whoever started them).
 */
export async function restartOwnedServer(): Promise<boolean> {
  if (!currentOwnedProcess) {
    return false;
  }

  try {
    currentOwnedProcess.kill();
    await currentOwnedProcess.exited;
  } catch {
    // Already exited.
  }
  currentOwnedProcess = null;

  const result = await ensureServerRunning();
  return result.ownedProcess !== null;
}

const healthCheckTimeoutMs = 1_500;
const startupPollIntervalMs = 250;
const startupPollAttempts = 40;

function getLightcodeDataDir(): string {
  const configuredHome = process.env.LIGHTCODE_HOME?.trim();
  if (configuredHome) {
    return path.resolve(configuredHome);
  }

  if (platform() === "win32") {
    const appData = process.env.APPDATA || process.env.LOCALAPPDATA;
    return appData
      ? path.join(appData, "lightcode")
      : path.join(homedir(), "AppData", "Roaming", "lightcode");
  }

  return path.join(homedir(), ".lightcode");
}

type ServerHealth = "healthy" | "foreign" | "down";

/**
 * Distinguishes "our server", "some other app on our port" (e.g. a user dev
 * server), and "nothing listening". Treating any 200 as healthy once routed
 * every CLI request to a Next.js dev server that shared the port.
 */
async function checkServer(url: string): Promise<ServerHealth> {
  try {
    const response = await fetch(new URL("/config/status", url), {
      signal: AbortSignal.timeout(healthCheckTimeoutMs),
    });

    if (!response.ok) {
      return "foreign";
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return "foreign";
    }

    const payload = (await response.json()) as Record<string, unknown> | null;
    return payload && typeof payload === "object" && "selectedProvider" in payload
      ? "healthy"
      : "foreign";
  } catch {
    return "down";
  }
}

function resolveServerEntry(): string | null {
  const candidates = [
    // Published layout: dist/cli.js next to dist/server.js.
    fileURLToPath(new URL("./server.js", import.meta.url)),
    // Monorepo layout: apps/cli/src/lib → apps/server/src/index.ts.
    fileURLToPath(new URL("../../../server/src/index.ts", import.meta.url)),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Makes sure a Lightcode server is reachable before the TUI starts: reuses a
 * healthy server at the configured URL, otherwise spawns one as a child
 * process with logs under the Lightcode data directory.
 */
export async function ensureServerRunning(): Promise<ServerLaunchResult> {
  const port = new URL(apiBaseUrl).port || "4983";
  const initialHealth = await checkServer(apiBaseUrl);

  if (initialHealth === "healthy") {
    return { url: apiBaseUrl, ownedProcess: null };
  }

  if (initialHealth === "foreign") {
    return {
      url: apiBaseUrl,
      ownedProcess: null,
      error:
        `Port ${port} is in use by another application (not Lightcode). ` +
        "Free the port, or point Lightcode elsewhere with " +
        "LIGHTCODE_API_URL (CLI) and PORT (server).",
    };
  }

  const serverEntry = resolveServerEntry();
  if (!serverEntry) {
    return { url: apiBaseUrl, ownedProcess: null };
  }

  const logDirectory = path.join(getLightcodeDataDir(), "logs");
  mkdirSync(logDirectory, { recursive: true });
  const logFile = Bun.file(path.join(logDirectory, "server.log"));

  const ownedProcess = Bun.spawn([process.execPath, serverEntry], {
    stdout: logFile,
    stderr: logFile,
    env: {
      ...process.env,
      PORT: port,
      // Let the server self-exit if this CLI dies abruptly (SIGKILL, terminal
      // close) — cases the process.on("exit") cleanup cannot cover. Without
      // this the server orphans on macOS and a later run reuses a stale one.
      LIGHTCODE_PARENT_PID: String(process.pid),
    },
  });

  for (let attempt = 0; attempt < startupPollAttempts; attempt += 1) {
    if ((await checkServer(apiBaseUrl)) === "healthy") {
      currentOwnedProcess = ownedProcess;
      return { url: apiBaseUrl, ownedProcess };
    }

    if (ownedProcess.exitCode !== null) {
      // Server died during startup (config error, port conflict, ...).
      return {
        url: apiBaseUrl,
        ownedProcess: null,
        error:
          "The Lightcode server exited during startup. Check the log at " +
          `${path.join(logDirectory, "server.log")} — a port conflict or ` +
          "invalid settings.json are the usual causes.",
      };
    }

    await Bun.sleep(startupPollIntervalMs);
  }

  currentOwnedProcess = ownedProcess;
  return { url: apiBaseUrl, ownedProcess };
}
