import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface ClipboardImage {
  /** IANA media type, currently always image/png (what the clipboard exports). */
  mediaType: string;
  base64: string;
  byteLength: number;
}

/**
 * Read an image from the macOS system clipboard, if one is present. Returns null
 * on non-macOS platforms, when the clipboard holds no image, or on any failure —
 * pasting must degrade silently to plain text, never throw into the input.
 *
 * Terminals deliver only text through bracketed paste, so a pasted screenshot
 * arrives as an empty paste; we recover the actual bytes from the clipboard here.
 */
export async function readClipboardImage(): Promise<ClipboardImage | null> {
  if (process.platform !== "darwin") {
    return null;
  }

  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(tmpdir(), "lightcode-clip-"));
    const file = path.join(dir, "clipboard.png");
    const wrote = await writeClipboardPngViaOsascript(file);
    if (!wrote) {
      return null;
    }

    const bytes = await readFile(file);
    if (bytes.byteLength === 0) {
      return null;
    }

    return {
      mediaType: "image/png",
      base64: bytes.toString("base64"),
      byteLength: bytes.byteLength,
    };
  } catch {
    return null;
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Ask AppleScript to dump the clipboard's PNG representation to `filePath`.
 * Resolves true only when an image was written; false when the clipboard has no
 * image or the script errors. Never rejects.
 */
function writeClipboardPngViaOsascript(filePath: string): Promise<boolean> {
  const script = [
    "try",
    "  set thePng to (the clipboard as «class PNGf»)",
    `  set fp to open for access POSIX file ${JSON.stringify(filePath)} with write permission`,
    "  set eof fp to 0",
    "  write thePng to fp",
    "  close access fp",
    '  return "OK"',
    "on error",
    "  try",
    "    close access fp",
    "  end try",
    '  return "NONE"',
    "end try",
  ];

  const args: string[] = [];
  for (const line of script) {
    args.push("-e", line);
  }

  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn("osascript", args, {
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(stdout.trim() === "OK"));
  });
}
