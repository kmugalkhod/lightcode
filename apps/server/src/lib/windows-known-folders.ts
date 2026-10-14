import path from "node:path";
import { z } from "zod";

export type WindowsKnownFolderId = "desktop" | "documents" | "downloads";

export type WindowsKnownFolders = Record<WindowsKnownFolderId, string | null>;

/** A cold Windows PowerShell start can take 10+ s; this only runs in the background. */
const resolverKillMs = 20_000;
/** How long an open request waits before using the environment fallbacks. */
const defaultWaitBudgetMs = 2_000;

const downloadsFolderGuid = "{374DE290-123F-4565-9164-39C4925E467B}";

// One process resolves all three folders: each PowerShell start costs seconds.
const knownFoldersScript = [
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
  "$desktop=[Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)",
  "$documents=[Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)",
  `$downloads=try{[Environment]::ExpandEnvironmentVariables([string](Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders' -Name '${downloadsFolderGuid}' -ErrorAction Stop).'${downloadsFolderGuid}')}catch{''}`,
  "[Console]::Write((@{desktop=$desktop;documents=$documents;downloads=$downloads}|ConvertTo-Json -Compress))",
].join(";");

const knownFolderValueSchema = z
  .string()
  .max(4_096)
  .transform((value) => value.trim())
  .transform((value) =>
    value && !/[\r\n\0]/.test(value) && path.win32.isAbsolute(value)
      ? value
      : null,
  );

const knownFoldersOutputSchema = z.object({
  desktop: knownFolderValueSchema,
  documents: knownFolderValueSchema,
  downloads: knownFolderValueSchema,
});

export function parseWindowsKnownFoldersOutput(
  output: string,
): WindowsKnownFolders | null {
  if (Buffer.byteLength(output) > 16_384) return null;
  try {
    const parsed = knownFoldersOutputSchema.safeParse(JSON.parse(output));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function runKnownFoldersResolver(
  environment: Record<string, string | undefined>,
): Promise<WindowsKnownFolders | null> {
  try {
    const systemRootCandidate =
      environment.SystemRoot?.trim() ||
      environment.WINDIR?.trim() ||
      "C:\\Windows";
    if (!path.win32.isAbsolute(systemRootCandidate)) return null;
    const windowsRoot = path.win32.normalize(systemRootCandidate);
    if (windowsRoot === path.win32.parse(windowsRoot).root) return null;
    const systemDirectory = path.win32.join(windowsRoot, "System32");
    const executable = path.win32.join(
      systemDirectory,
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const child = Bun.spawn(
      [
        executable,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        knownFoldersScript,
      ],
      {
        cwd: systemDirectory,
        env: {
          SystemRoot: windowsRoot,
          WINDIR: windowsRoot,
          ...Object.fromEntries(
            ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"].flatMap(
              (name) =>
                environment[name] ? [[name, environment[name] as string]] : [],
            ),
          ),
        },
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
        windowsHide: true,
      },
    );
    const timeout = setTimeout(() => child.kill(), resolverKillMs);
    timeout.unref();
    try {
      const [output, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);
      return exitCode === 0 ? parseWindowsKnownFoldersOutput(output) : null;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

const resolverCache = new Map<string, Promise<WindowsKnownFolders | null>>();

function cacheKey(environment: Record<string, string | undefined>): string {
  return JSON.stringify(
    ["SystemRoot", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].map(
      (name) => environment[name] ?? null,
    ),
  );
}

/**
 * Resolves Desktop/Documents/Downloads once per process (per environment).
 * A failed run is forgotten so a later request can try again.
 */
export function resolveWindowsKnownFolders(
  environment: Record<string, string | undefined>,
  run: typeof runKnownFoldersResolver = runKnownFoldersResolver,
): Promise<WindowsKnownFolders | null> {
  const key = cacheKey(environment);
  const cached = resolverCache.get(key);
  if (cached) return cached;
  const pending = run(environment).then((folders) => {
    if (!folders) resolverCache.delete(key);
    return folders;
  });
  resolverCache.set(key, pending);
  return pending;
}

/**
 * Waits for the shared resolver up to `budgetMs`. A slow first run keeps going
 * in the background, so later opens get the real (possibly redirected) folder.
 */
export async function resolveWindowsKnownFolder(
  environment: Record<string, string | undefined>,
  folder: WindowsKnownFolderId,
  {
    budgetMs = defaultWaitBudgetMs,
    run,
  }: { budgetMs?: number; run?: typeof runKnownFoldersResolver } = {},
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  try {
    const folders = await Promise.race([
      resolveWindowsKnownFolders(environment, run),
      budget,
    ]);
    return folders?.[folder] ?? null;
  } finally {
    clearTimeout(timer);
  }
}

export function clearWindowsKnownFoldersCache(): void {
  resolverCache.clear();
}
