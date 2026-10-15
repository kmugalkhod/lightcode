/** Display-only platform hints; never used for security decisions. */
function clientPlatform(): string {
  if (typeof navigator === "undefined") return "";
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return nav.userAgentData?.platform || nav.platform || "";
}

export function isWindowsClient(platform = clientPlatform()): boolean {
  return /^win/i.test(platform);
}

export function isMacClient(platform = clientPlatform()): boolean {
  return /^mac/i.test(platform);
}

/** Formats a Ctrl/Cmd shortcut the way the viewer's OS writes it. */
export function shortcutLabel(
  keys: { shift?: boolean; key: string },
  platform = clientPlatform(),
): string {
  if (isMacClient(platform)) {
    return `⌘${keys.shift ? "⇧" : ""}${keys.key}`;
  }
  return `Ctrl+${keys.shift ? "Shift+" : ""}${keys.key}`;
}

/** Label for the button that opens the OS folder dialog instead. */
export function systemFolderDialogLabel(platform = clientPlatform()): string {
  if (isWindowsClient(platform)) return "Use Windows dialog";
  if (isMacClient(platform)) return "Use Finder";
  return "Use system dialog";
}
