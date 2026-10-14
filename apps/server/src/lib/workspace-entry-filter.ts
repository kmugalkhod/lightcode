/** Registry hives, shell metadata, and drive-root system files. */
const windowsSystemEntryPattern =
  /^(?:ntuser\.(?:dat|ini|pol)(?:[.{].*)?|desktop\.ini|thumbs\.db|\$recycle\.bin|system volume information|pagefile\.sys|hiberfil\.sys|swapfile\.sys|dumpstack\.log(?:\.tmp)?|config\.msi|\$windows\.~(?:bt|ws)|\$winreagent|\$sysreset)$/i;

/**
 * Pre-Vista compatibility junctions in profiles and Documents. They are
 * access-denied links that only duplicate real folders, so they are noise.
 * Matched only when the entry is a link: a real folder with one of these
 * names stays visible.
 */
const windowsLegacyJunctionNames = new Set(
  [
    "application data",
    "cookies",
    "local settings",
    "my documents",
    "nethood",
    "printhood",
    "recent",
    "sendto",
    "start menu",
    "templates",
    "my music",
    "my pictures",
    "my videos",
    "documents and settings",
  ],
);

export interface BrowserEntryCandidate {
  name: string;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** Hidden entries appear only when the browser asks for hidden items. */
export function isHiddenBrowserEntry(
  entry: BrowserEntryCandidate,
  platform: typeof process.platform = process.platform,
): boolean {
  if (entry.name.startsWith(".")) return true;
  if (platform !== "win32") return false;
  if (windowsSystemEntryPattern.test(entry.name)) return true;
  return (
    entry.isSymbolicLink() &&
    windowsLegacyJunctionNames.has(entry.name.toLowerCase())
  );
}

/** Folder-only listings keep links and unknown kinds; describing them decides. */
export function isOmittedFromFolderListing(entry: BrowserEntryCandidate): boolean {
  return entry.isFile();
}
