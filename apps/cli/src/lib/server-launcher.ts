import { existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiBaseUrl } from "./api-base-url";

export interface ServerLaunchResult {
  url: string;
  /** Child process when this CLI started the server; null if it was already up. */
  ownedProcess: ReturnType<typeof Bun.spawn> | null;
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

async function isServerHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/config/status", url), {
      signal: AbortSignal.timeout(healthCheckTimeoutMs),
    });
    return response.ok;
  } catch {
    return false;
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
  if (await isServerHealthy(apiBaseUrl)) {
    return { url: apiBaseUrl, ownedProcess: null };
  }

  const serverEntry = resolveServerEntry();
  if (!serverEntry) {
    return { url: apiBaseUrl, ownedProcess: null };
  }

  const logDirectory = path.join(getLightcodeDataDir(), "logs");
  mkdirSync(logDirectory, { recursive: true });
  const logFile = Bun.file(path.join(logDirectory, "server.log"));
  const port = new URL(apiBaseUrl).port || "3000";

  const ownedProcess = Bun.spawn([process.execPath, serverEntry], {
    stdout: logFile,
    stderr: logFile,
    env: {
      ...process.env,
      PORT: port,
    },
  });

  for (let attempt = 0; attempt < startupPollAttempts; attempt += 1) {
    if (await isServerHealthy(apiBaseUrl)) {
      currentOwnedProcess = ownedProcess;
      return { url: apiBaseUrl, ownedProcess };
    }

    if (ownedProcess.exitCode !== null) {
      // Server died during startup (config error, port conflict, ...).
      return { url: apiBaseUrl, ownedProcess: null };
    }

    await Bun.sleep(startupPollIntervalMs);
  }

  currentOwnedProcess = ownedProcess;
  return { url: apiBaseUrl, ownedProcess };
}
