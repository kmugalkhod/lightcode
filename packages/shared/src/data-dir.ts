import { homedir, platform } from "node:os";
import path from "node:path";

/**
 * Per-user Lightcode data directory (logs, checkpoints, local database).
 * Override with LIGHTCODE_HOME.
 */
export function getLightcodeDataDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const configuredHome = env.LIGHTCODE_HOME?.trim();
  if (configuredHome) {
    return path.resolve(configuredHome);
  }

  if (platform() === "win32") {
    const appData = env.APPDATA || env.LOCALAPPDATA;
    return appData
      ? path.join(appData, "lightcode")
      : path.join(homedir(), "AppData", "Roaming", "lightcode");
  }

  return path.join(homedir(), ".lightcode");
}
