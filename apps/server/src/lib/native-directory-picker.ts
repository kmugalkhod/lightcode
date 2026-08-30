import path from "node:path";
import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";

const maximumPickerOutputBytes = 16 * 1_024;

export type NativeDirectoryPickerResult =
  | { outcome: "selected"; directory: string }
  | { outcome: "cancelled" };

export type NativeDirectoryPickerErrorCode =
  | "native_picker_busy"
  | "native_picker_unavailable"
  | "native_picker_failed";

export class NativeDirectoryPickerError extends Error {
  constructor(
    readonly code: NativeDirectoryPickerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NativeDirectoryPickerError";
  }
}

export interface NativePickerProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type NativePickerProcessRunner = (
  command: readonly string[],
  signal?: AbortSignal,
) => Promise<NativePickerProcessResult>;

export interface NativeDirectoryPickerOptions {
  platform?: typeof process.platform;
  environment?: Record<string, string | undefined>;
  which?: (command: string) => string | null;
  runProcess?: NativePickerProcessRunner;
}

export interface NativeDirectoryPicker {
  pick(signal?: AbortSignal): Promise<NativeDirectoryPickerResult>;
}

interface PickerCommand {
  kind: "windows" | "macos" | "zenity" | "kdialog";
  argv: string[];
}

const trustedLinuxExecutableDirectories = [
  "/usr/bin",
  "/bin",
  "/run/current-system/sw/bin",
] as const;

class PickerOutputTooLargeError extends Error {}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        throw new PickerOutputTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

export const runNativePickerProcess: NativePickerProcessRunner = async (
  command,
  signal,
) => {
  if (signal?.aborted) {
    return { exitCode: 1, stdout: "", stderr: "" };
  }

  const child = Bun.spawn([...command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  let aborted = false;
  const abort = () => {
    aborted = true;
    try {
      child.kill();
    } catch {
      // The dialog process may have exited between the signal and cleanup.
    }
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedStream(child.stdout, maximumPickerOutputBytes),
      readBoundedStream(child.stderr, maximumPickerOutputBytes),
      child.exited,
    ]);
    return {
      exitCode: aborted ? 1 : exitCode,
      stdout: aborted ? "" : stdout,
      stderr: aborted ? "" : stderr,
    };
  } catch (error) {
    abort();
    if (error instanceof PickerOutputTooLargeError) {
      throw new NativeDirectoryPickerError(
        "native_picker_failed",
        "The system folder picker returned an invalid response.",
      );
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
};

const windowsPickerScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a project folder'
$dialog.ShowNewFolderButton = $true
$dialog.AutoUpgradeEnabled = $true
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$owner.Location = New-Object System.Drawing.Point(-32000, -32000)
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
try {
  $owner.Show()
  $owner.Activate()
  $result = $dialog.ShowDialog($owner)
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)
    [Console]::Out.Write('selected:' + [Convert]::ToBase64String($bytes))
  } else {
    [Console]::Out.Write('cancelled')
  }
} finally {
  $dialog.Dispose()
  $owner.Dispose()
}
`;

const macosPickerScript = String.raw`
try
  set chosenFolder to choose folder with prompt "Choose a project folder"
  return POSIX path of chosenFolder
on error number -128
  error number -128
end try
`;

function stripToolLineEnding(value: string): string {
  return value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
}

function assertPickerPath(
  value: string,
  pathApi: typeof path.posix | typeof path.win32,
): string {
  const windowsRoot =
    pathApi === path.win32 ? path.win32.parse(value).root : null;
  const isFullyQualifiedWindowsPath =
    windowsRoot === null ||
    /^[A-Za-z]:[\\/]$/.test(windowsRoot) ||
    /^\\\\(?![?.][\\/])[^\\/]+[\\/][^\\/]+[\\/]$/.test(windowsRoot);
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes("\0") ||
    !pathApi.isAbsolute(value) ||
    !isFullyQualifiedWindowsPath
  ) {
    throw new NativeDirectoryPickerError(
      "native_picker_failed",
      "The system folder picker returned an invalid folder.",
    );
  }
  return value;
}

function parseWindowsResult(
  result: NativePickerProcessResult,
): NativeDirectoryPickerResult {
  const output = stripToolLineEnding(result.stdout);
  if (result.exitCode !== 0) {
    throw new NativeDirectoryPickerError(
      "native_picker_failed",
      "The Windows folder picker could not be opened.",
    );
  }
  if (output === "cancelled") return { outcome: "cancelled" };
  if (!output.startsWith("selected:")) {
    throw new NativeDirectoryPickerError(
      "native_picker_failed",
      "The Windows folder picker returned an invalid response.",
    );
  }

  const encoded = output.slice("selected:".length);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new NativeDirectoryPickerError(
      "native_picker_failed",
      "The Windows folder picker returned an invalid response.",
    );
  }
  try {
    const directory = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(encoded, "base64"),
    );
    if (
      Buffer.from(directory, "utf8").toString("base64").replace(/=+$/, "") !==
      encoded.replace(/=+$/, "")
    ) {
      throw new Error("invalid base64");
    }
    return {
      outcome: "selected",
      directory: assertPickerPath(directory, path.win32),
    };
  } catch (error) {
    if (error instanceof NativeDirectoryPickerError) throw error;
    throw new NativeDirectoryPickerError(
      "native_picker_failed",
      "The Windows folder picker returned an invalid response.",
    );
  }
}

function parseMacosResult(
  result: NativePickerProcessResult,
): NativeDirectoryPickerResult {
  if (result.exitCode !== 0) {
    if (/\(-128\)|user canceled/i.test(result.stderr)) {
      return { outcome: "cancelled" };
    }
    throw new NativeDirectoryPickerError(
      "native_picker_failed",
      "The macOS folder picker could not be opened.",
    );
  }
  return {
    outcome: "selected",
    directory: assertPickerPath(stripToolLineEnding(result.stdout), path.posix),
  };
}

function parseLinuxResult(
  result: NativePickerProcessResult,
): NativeDirectoryPickerResult {
  if (result.exitCode === 1) return { outcome: "cancelled" };
  if (result.exitCode !== 0) {
    throw new NativeDirectoryPickerError(
      "native_picker_failed",
      "The Linux folder picker could not be opened.",
    );
  }
  return {
    outcome: "selected",
    directory: assertPickerPath(stripToolLineEnding(result.stdout), path.posix),
  };
}

function resolvePickerCommand({
  platform,
  environment,
  which,
}: {
  platform: typeof process.platform;
  environment: Record<string, string | undefined>;
  which: (command: string) => string | null;
}): PickerCommand | null {
  if (platform === "win32") {
    const configuredRoot = environment.SystemRoot?.trim();
    const systemRoot =
      configuredRoot && path.win32.isAbsolute(configuredRoot)
        ? configuredRoot
        : "C:\\Windows";
    const candidate = path.win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const executable = which(candidate);
    if (!executable || !path.win32.isAbsolute(executable)) return null;
    return {
      kind: "windows",
      argv: [
        executable,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-EncodedCommand",
        Buffer.from(windowsPickerScript, "utf16le").toString("base64"),
      ],
    };
  }

  if (platform === "darwin") {
    const executable = which("/usr/bin/osascript");
    if (!executable || !path.posix.isAbsolute(executable)) return null;
    return {
      kind: "macos",
      argv: [executable, "-e", macosPickerScript],
    };
  }

  if (platform === "linux") {
    if (!environment.DISPLAY?.trim() && !environment.WAYLAND_DISPLAY?.trim()) {
      return null;
    }
    const desktop = environment.XDG_CURRENT_DESKTOP?.toLowerCase() ?? "";
    const candidates = desktop.includes("kde")
      ? (["kdialog", "zenity"] as const)
      : (["zenity", "kdialog"] as const);
    for (const command of candidates) {
      let executable: string | null = null;
      for (const directory of trustedLinuxExecutableDirectories) {
        const candidate = path.posix.join(directory, command);
        const resolved = which(candidate);
        if (resolved === candidate) {
          executable = resolved;
          break;
        }
      }
      if (!executable) continue;
      if (command === "zenity") {
        return {
          kind: "zenity",
          argv: [
            executable,
            "--file-selection",
            "--directory",
            "--title=Choose a project folder",
          ],
        };
      }
      return {
        kind: "kdialog",
        argv: [
          executable,
          "--title",
          "Choose a project folder",
          "--getexistingdirectory",
          path.posix.isAbsolute(homedir()) ? homedir() : "/",
        ],
      };
    }
  }

  return null;
}

export function createNativeDirectoryPicker(
  options: NativeDirectoryPickerOptions = {},
): NativeDirectoryPicker {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? Bun.env;
  const which =
    options.which ??
    ((candidate: string) => {
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        return null;
      }
    });
  const runProcess = options.runProcess ?? runNativePickerProcess;
  let active = false;

  return {
    async pick(signal) {
      if (active) {
        throw new NativeDirectoryPickerError(
          "native_picker_busy",
          "A folder picker is already open.",
        );
      }
      if (signal?.aborted) return { outcome: "cancelled" };

      const command = resolvePickerCommand({ platform, environment, which });
      if (!command) {
        throw new NativeDirectoryPickerError(
          "native_picker_unavailable",
          "No supported system folder picker is available.",
        );
      }

      active = true;
      try {
        const result = await runProcess(command.argv, signal);
        if (signal?.aborted) return { outcome: "cancelled" };
        if (command.kind === "windows") return parseWindowsResult(result);
        if (command.kind === "macos") return parseMacosResult(result);
        return parseLinuxResult(result);
      } catch (error) {
        if (error instanceof NativeDirectoryPickerError) throw error;
        throw new NativeDirectoryPickerError(
          "native_picker_failed",
          "The system folder picker could not be opened.",
        );
      } finally {
        active = false;
      }
    },
  };
}
