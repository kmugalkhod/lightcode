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
    /** Log-only stderr excerpt. Never return it in an HTTP response. */
    readonly diagnostic?: string,
  ) {
    super(message);
    this.name = "NativeDirectoryPickerError";
  }
}

const maximumDiagnosticLength = 500;

/** Windows PowerShell serializes stderr as CLIXML; keep only the error text. */
function unwrapClixml(stderr: string): string {
  if (!stderr.startsWith("#< CLIXML")) return stderr;
  const errors = [...stderr.matchAll(/<S S="Error">([^<]*)<\/S>/g)].map(
    (match) => match[1] ?? "",
  );
  return errors
    .join("")
    .replace(/_x000D_/g, "")
    .replace(/_x000A_/g, " ");
}

function pickerDiagnostic(stderr: string): string | undefined {
  const cleaned = unwrapClixml(stderr)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, maximumDiagnosticLength);
  return cleaned || undefined;
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

/**
 * Runs under Windows PowerShell 5.1 (.NET Framework). Its FolderBrowserDialog
 * is the cramped XP-era tree and lacks the modern-.NET members (auto-upgrade,
 * description-as-title, initial directory); setting one throws under
 * ErrorActionPreference=Stop and the dialog never opens. So the script
 * compiles a small IFileOpenDialog wrapper for the Explorer-style folder
 * dialog and keeps FolderBrowserDialog only as the fallback for hosts that
 * refuse to compile it (constrained language mode, blocked csc.exe). The
 * windows smoke test runs everything above the `lightcode:show-dialog` marker
 * for real to catch that class of bug.
 */
const windowsPickerScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$modernPicker = $false
try {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace Lightcode {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  internal class FileOpenDialogCoClass {}

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, out IntPtr ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  // IFileOpenDialog; only the IModalWindow/IFileDialog prefix of the vtable
  // is declared, in order.
  [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
  }

  public static class FolderPicker {
    const uint PickFolders = 0x20, ForceFileSystem = 0x40, PathMustExist = 0x800, NoChangeDir = 0x8;
    const uint FileSystemPath = 0x80058000;
    const int Cancelled = unchecked((int)0x800704C7);

    // Returns the chosen folder, or null when the user cancels.
    public static string Pick(IntPtr owner, string title) {
      var dialog = (IFileOpenDialog)new FileOpenDialogCoClass();
      try {
        uint options;
        dialog.GetOptions(out options);
        dialog.SetOptions(options | PickFolders | ForceFileSystem | PathMustExist | NoChangeDir);
        dialog.SetTitle(title);
        dialog.SetOkButtonLabel("Open project");
        int hr = dialog.Show(owner);
        if (hr == Cancelled) return null;
        Marshal.ThrowExceptionForHR(hr);
        IShellItem item;
        dialog.GetResult(out item);
        IntPtr name;
        item.GetDisplayName(FileSystemPath, out name);
        try {
          return Marshal.PtrToStringUni(name);
        } finally {
          Marshal.FreeCoTaskMem(name);
        }
      } finally {
        Marshal.ReleaseComObject(dialog);
      }
    }
  }
}
'@
  $modernPicker = $true
} catch {
  $modernPicker = $false
}
$owner = New-Object System.Windows.Forms.Form
$owner.Text = 'Lightcode - choose a project folder'
$owner.TopMost = $true
# A taskbar button keeps the dialog findable when Windows refuses to bring it
# in front of the browser.
$owner.ShowInTaskbar = $true
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$workArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$owner.Location = New-Object System.Drawing.Point(
  [int]($workArea.Left + $workArea.Width / 2),
  [int]($workArea.Top + $workArea.Height / 2))
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
# lightcode:show-dialog
try {
  # The spawner's windowsHide turns the process's first show into SW_HIDE.
  # Showing again makes the owner, and its taskbar button, actually visible.
  $owner.Show()
  $owner.Hide()
  $owner.Show()
  $owner.Activate()
  $selected = $null
  $shown = $false
  if ($modernPicker) {
    try {
      $selected = [Lightcode.FolderPicker]::Pick($owner.Handle, 'Choose a project folder')
      $shown = $true
    } catch {
      # The dialog failed to open; fall back to the classic picker below.
    }
  }
  if (-not $shown) {
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Choose a project folder'
    $dialog.ShowNewFolderButton = $true
    try {
      if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
        $selected = $dialog.SelectedPath
      }
    } finally {
      $dialog.Dispose()
    }
  }
  if ($selected) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($selected)
    [Console]::Out.Write('selected:' + [Convert]::ToBase64String($bytes))
  } else {
    [Console]::Out.Write('cancelled')
  }
} finally {
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
      pickerDiagnostic(result.stderr),
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
      pickerDiagnostic(result.stderr),
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
      pickerDiagnostic(result.stderr),
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
