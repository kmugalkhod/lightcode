import { platform } from "node:os";

/** Minimal slice of the OpenTUI renderer this module needs (from useRenderer()). */
export interface ClipboardCapableRenderer {
  copyToClipboardOSC52?: (text: string) => boolean;
}

/**
 * Copies text to the system clipboard.
 *
 * Two independent paths, because neither is universal on its own:
 *  - OSC 52 (via the OpenTUI renderer) reaches the clipboard even over SSH, but
 *    some terminals — and Windows conpty — ship with it disabled.
 *  - The OS-native tool (clip / pbcopy / xclip / wl-copy) is reliable locally
 *    but useless on a remote host.
 *
 * We attempt both and report success if either path worked.
 */
export async function copyText(
  renderer: ClipboardCapableRenderer | null | undefined,
  text: string,
): Promise<boolean> {
  if (!text) {
    return false;
  }

  let copied = false;

  try {
    if (renderer?.copyToClipboardOSC52?.(text)) {
      copied = true;
    }
  } catch {
    // OSC 52 unsupported by this terminal — fall through to the native tool.
  }

  if (await copyViaNativeTool(text)) {
    copied = true;
  }

  return copied;
}

/** Returns the fixed native clipboard command for platforms that have one. */
function nativeClipboardCommand(): string[] | null {
  switch (platform()) {
    case "win32":
      return ["clip"];
    case "darwin":
      return ["pbcopy"];
    default:
      // Linux/BSD is resolved at runtime (Wayland first, then X11).
      return null;
  }
}

async function copyViaNativeTool(text: string): Promise<boolean> {
  const direct = nativeClipboardCommand();
  if (direct) {
    return spawnCopy(direct, text);
  }

  if (await spawnCopy(["wl-copy"], text)) {
    return true;
  }
  return spawnCopy(["xclip", "-selection", "clipboard"], text);
}

async function spawnCopy(command: string[], text: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(command, {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.stdin.write(text);
    await proc.stdin.end();
    return (await proc.exited) === 0;
  } catch {
    // Tool not installed / not on PATH.
    return false;
  }
}
