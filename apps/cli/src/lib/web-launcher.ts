import {
  chmodSync,
  mkdtempSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { platform } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const bootstrapLifetimeMs = 60_000;

export interface WebBootstrapFile {
  filePath: string;
  fileUrl: string;
  cleanup: () => void;
}

export function buildWebAppUrl(baseUrl: string, token: string): string {
  const url = new URL("/app/", baseUrl);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

export function getBrowserOpenCommand(
  target: string,
  operatingSystem = platform(),
): string[] {
  if (operatingSystem === "darwin") {
    return ["open", target];
  }

  if (operatingSystem === "win32") {
    // Avoid cmd.exe: a temporary path can contain shell metacharacters, and
    // opening a browser must never reinterpret them as commands.
    return ["rundll32.exe", "url.dll,FileProtocolHandler", target];
  }

  return ["xdg-open", target];
}

/**
 * Keeps the long-lived bearer out of `open`/`xdg-open` process arguments.
 * The browser receives only a path inside a mode-0700 temporary directory,
 * reads the mode-0600 redirect document as the current OS user, and then
 * replaces that local page with the authenticated localhost URL.
 */
export function createWebBootstrapFile(url: string): WebBootstrapFile {
  const directory = mkdtempSync(path.join(tmpdir(), "lightcode-web-"));
  chmodSync(directory, 0o700);
  const filePath = path.join(directory, "open.html");
  const serializedUrl = JSON.stringify(url).replaceAll("<", "\\u003c");
  writeFileSync(
    filePath,
    `<!doctype html><meta charset="utf-8"><title>Opening Lightcode</title><script>location.replace(${serializedUrl})</script>`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );

  let cleaned = false;
  return {
    filePath,
    fileUrl: pathToFileURL(filePath).toString(),
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      try {
        unlinkSync(filePath);
      } catch {
        // The browser bootstrap may already have been cleaned up.
      }
      try {
        rmdirSync(directory);
      } catch {
        // Leave an empty private temp directory only if the OS still uses it.
      }
    },
  };
}

export function openWebApp(url: string): boolean {
  let bootstrap: WebBootstrapFile | null = null;
  try {
    bootstrap = createWebBootstrapFile(url);
    const result = Bun.spawnSync(getBrowserOpenCommand(bootstrap.fileUrl), {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) {
      bootstrap.cleanup();
      return false;
    }

    const cleanupTimer = setTimeout(bootstrap.cleanup, bootstrapLifetimeMs);
    cleanupTimer.unref();
    return true;
  } catch {
    bootstrap?.cleanup();
    return false;
  }
}
