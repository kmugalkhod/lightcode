import { randomBytes, randomUUID } from "node:crypto";
import { networkFetch } from "@lightcode/shared/network";
import {
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

export interface WebServerLaunchResult extends ServerLaunchResult {
  /** Per-launch browser credential, carried only in the URL fragment. */
  token: string;
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
const webPortProbeCount = 12;

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

export function existingLightcodeInterfaceError(
  requestedInterface: "browser" | "terminal",
  port: string | number,
): string {
  const currentInterface =
    requestedInterface === "browser" ? "terminal" : "browser";
  return (
    `A Lightcode ${currentInterface} interface is already running on port ${port}. ` +
    `Stop it before starting the ${requestedInterface} interface. ` +
    "This release supports one Lightcode interface at a time."
  );
}

/**
 * Distinguishes "our server", "some other app on our port" (e.g. a user dev
 * server), and "nothing listening". Treating any 200 as healthy once routed
 * every CLI request to a Next.js dev server that shared the port.
 */
async function checkServer(url: string): Promise<ServerHealth> {
  try {
    const response = await networkFetch(new URL("/config/status", url), {
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

async function checkWebPort(url: string): Promise<ServerHealth> {
  try {
    const response = await networkFetch(new URL("/healthz", url), {
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
    return payload?.service === "lightcode" ? "healthy" : "foreign";
  } catch {
    return "down";
  }
}

async function checkAuthenticatedWebServer(
  url: string,
  token: string,
): Promise<boolean> {
  try {
    const response = await networkFetch(new URL("/config/status", url), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(healthCheckTimeoutMs),
    });
    if (!response.ok) {
      return false;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return false;
    }

    const payload = (await response.json()) as Record<string, unknown> | null;
    return Boolean(payload && "selectedProvider" in payload);
  } catch {
    return false;
  }
}

export function resolveServerEntryFromModuleUrl(
  moduleUrl: string,
  pathExists: (candidate: string) => boolean = existsSync,
): string | null {
  // Published layout: dist/cli.js sits next to dist/server.js.
  const adjacentServer = fileURLToPath(new URL("./server.js", moduleUrl));
  if (pathExists(adjacentServer)) {
    return adjacentServer;
  }

  // Only a real source checkout may use the monorepo fallback. Without this
  // shape check, a broken npm install could execute an unrelated
  // ../../../server/src/index.ts from the consuming project.
  const modulePath = fileURLToPath(moduleUrl);
  const sourceSuffix = path.join(
    "apps",
    "cli",
    "src",
    "lib",
    "server-launcher.ts",
  );
  if (!modulePath.endsWith(sourceSuffix)) {
    return null;
  }

  const sourceServer = fileURLToPath(
    new URL("../../../server/src/index.ts", moduleUrl),
  );
  return pathExists(sourceServer) ? sourceServer : null;
}

function resolveServerEntry(): string | null {
  return resolveServerEntryFromModuleUrl(import.meta.url);
}

function parseWebStartPort(): number {
  const configured = process.env.LIGHTCODE_WEB_PORT?.trim();
  const fromApiUrl = new URL(apiBaseUrl).port;
  const candidate = Number(configured || fromApiUrl || "4983");

  if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65_535) {
    throw new Error(
      "LIGHTCODE_WEB_PORT must be an integer between 1 and 65535.",
    );
  }

  return candidate;
}

function createWebAuthHandoff(port: number) {
  const runtimeDirectory = path.join(getLightcodeDataDir(), "runtime");
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });

  const token = randomBytes(32).toString("base64url");
  const authFile = path.join(
    runtimeDirectory,
    `web-auth-${port}-${randomUUID()}.json`,
  );
  writeFileSync(
    authFile,
    `${JSON.stringify({
      version: 1,
      token,
      createdAt: new Date().toISOString(),
    })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );

  return { authFile, token };
}

function removeHandoffIfPresent(authFile: string) {
  try {
    unlinkSync(authFile);
  } catch {
    // The server removes a successfully consumed handoff itself.
  }
}

/**
 * Starts a dedicated authenticated server for the browser UI. The browser and
 * terminal deliberately cannot run side by side yet because they share one
 * durable run store; fail clearly when another Lightcode interface owns it.
 */
export async function startAuthenticatedWebServer(): Promise<WebServerLaunchResult> {
  const serverEntry = resolveServerEntry();
  if (!serverEntry) {
    return {
      url: apiBaseUrl,
      ownedProcess: null,
      token: "",
      error: "Lightcode's server entry could not be found.",
    };
  }

  const logDirectory = path.join(getLightcodeDataDir(), "logs");
  mkdirSync(logDirectory, { recursive: true });
  const logFile = Bun.file(path.join(logDirectory, "web-server.log"));
  const startPort = parseWebStartPort();

  for (let offset = 0; offset < webPortProbeCount; offset += 1) {
    const port = startPort + offset;
    if (port > 65_535) {
      break;
    }

    const url = `http://127.0.0.1:${port}`;
    const portHealth = await checkWebPort(url);
    if (portHealth === "healthy") {
      return {
        url,
        ownedProcess: null,
        token: "",
        error: existingLightcodeInterfaceError("browser", port),
      };
    }
    if (portHealth === "foreign") {
      continue;
    }

    const { authFile, token } = createWebAuthHandoff(port);
    const ownedProcess = Bun.spawn([process.execPath, serverEntry], {
      stdout: logFile,
      stderr: logFile,
      env: {
        ...process.env,
        PORT: String(port),
        LIGHTCODE_HOST: "127.0.0.1",
        LIGHTCODE_PARENT_PID: String(process.pid),
        LIGHTCODE_WEB_AUTH_FILE: authFile,
      },
    });

    for (let attempt = 0; attempt < startupPollAttempts; attempt += 1) {
      if (await checkAuthenticatedWebServer(url, token)) {
        currentOwnedProcess = ownedProcess;
        return { url, ownedProcess, token };
      }

      if (ownedProcess.exitCode !== null) {
        removeHandoffIfPresent(authFile);
        return {
          url,
          ownedProcess: null,
          token: "",
          error:
            "The Lightcode browser server exited during startup. Check the log at " +
            `${path.join(logDirectory, "web-server.log")}.`,
        };
      }

      await Bun.sleep(startupPollIntervalMs);
    }

    if (ownedProcess.exitCode === null) {
      try {
        ownedProcess.kill();
      } catch {
        // Process already stopped while the timeout was handled.
      }
    }
    removeHandoffIfPresent(authFile);
  }

  return {
    url: apiBaseUrl,
    ownedProcess: null,
    token: "",
    error:
      `Unable to start the browser server on ports ${startPort}-${Math.min(
        65_535,
        startPort + webPortProbeCount - 1,
      )}. Close another Lightcode process or set LIGHTCODE_WEB_PORT.`,
  };
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
    if ((await checkWebPort(apiBaseUrl)) === "healthy") {
      return {
        url: apiBaseUrl,
        ownedProcess: null,
        error: existingLightcodeInterfaceError("terminal", port),
      };
    }

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
