import { promises as fs } from "node:fs";

/** Drive tokens are exactly one letter and a colon, as listed by the server. */
export const windowsDriveTokenPattern = /^[A-Z]:$/;

export interface WindowsDrive {
  token: string;
  /** False when the drive did not answer in time (e.g. a disconnected share). */
  readable: boolean;
}

const driveProbeTimeoutMs = 1_500;

type DriveProbeResult = "present" | "absent" | "unresponsive";

async function probeDriveRoot(root: string): Promise<DriveProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DriveProbeResult>((resolve) => {
    timer = setTimeout(() => resolve("unresponsive"), driveProbeTimeoutMs);
  });
  try {
    return await Promise.race([
      fs
        .stat(root)
        .then((stats): DriveProbeResult => (stats.isDirectory() ? "present" : "absent"))
        .catch((error: unknown): DriveProbeResult => {
          const code =
            typeof error === "object" && error !== null
              ? Reflect.get(error, "code")
              : undefined;
          // A locked drive (BitLocker) or denied root is still a drive.
          return code === "EPERM" || code === "EACCES" || code === "EBUSY"
            ? "unresponsive"
            : "absent";
        }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lists drive letters C: to Z: in parallel. Only the drive roots are stat'ed;
 * nothing inside a drive is read until the user opens it. A: and B: are
 * skipped because probing legacy floppy letters can stall.
 */
export async function listWindowsDrives(
  probe: (root: string) => Promise<DriveProbeResult> = probeDriveRoot,
): Promise<WindowsDrive[]> {
  const letters = Array.from({ length: 24 }, (_, index) =>
    String.fromCharCode("C".charCodeAt(0) + index),
  );
  const results = await Promise.all(
    letters.map(async (letter) => ({
      token: `${letter}:`,
      state: await probe(`${letter}:\\`),
    })),
  );
  return results
    .filter((result) => result.state !== "absent")
    .map((result) => ({
      token: result.token,
      readable: result.state === "present",
    }));
}

export function windowsDriveRoot(token: string): string {
  return `${token}\\`;
}
