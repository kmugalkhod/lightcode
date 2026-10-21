import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The shell the bash tool runs commands in. Models write POSIX shell, so on
 * Windows Lightcode uses Git Bash when it can find one; cmd.exe (Node's
 * default there) mangles `\"` quoting, reads `<` and `>` inside quotes as
 * redirections, and runs only the first line of a multi-line command.
 */
export type CommandShell =
  | { kind: "posix" }
  | { kind: "git-bash"; path: string }
  | { kind: "cmd" };

type Exists = (file: string) => boolean;

/**
 * Where Git for Windows keeps bash.exe, starting from the folders that hold
 * git.exe on PATH (`Git\cmd`, `Git\bin`, `Git\mingw64\bin`). `bin\bash.exe`
 * is the launcher that puts the Unix tools on PATH. A bare `bash` on PATH is
 * usually WSL's (System32 or WindowsApps), which runs Linux paths in a VM,
 * so it is never used.
 */
function gitBashCandidates(env: NodeJS.ProcessEnv, exists: Exists): string[] {
  const pathValue =
    Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
  const fromGit = pathValue
    .split(path.win32.delimiter)
    .filter((entry) => entry && exists(path.win32.join(entry, "git.exe")))
    .flatMap((entry) => [
      path.win32.join(entry, "..", "bin", "bash.exe"),
      path.win32.join(entry, "bash.exe"),
      path.win32.join(entry, "..", "..", "bin", "bash.exe"),
    ]);
  const knownRoots = [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs"),
  ].filter((root): root is string => Boolean(root));
  const known = knownRoots.map((root) => path.win32.join(root, "Git", "bin", "bash.exe"));
  if (env.USERPROFILE) {
    known.push(path.win32.join(env.USERPROFILE, "scoop", "apps", "git", "current", "bin", "bash.exe"));
  }
  return [...fromGit, ...known].map((candidate) => path.win32.normalize(candidate));
}

/**
 * Picks the shell for `platform`. LIGHTCODE_GIT_BASH_PATH names a bash.exe,
 * or "off" for cmd.exe.
 */
export function findCommandShell(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: Exists = existsSync,
): CommandShell {
  if (platform !== "win32") return { kind: "posix" };
  const override = env.LIGHTCODE_GIT_BASH_PATH?.trim();
  if (override?.toLowerCase() === "off") return { kind: "cmd" };
  if (override && exists(override)) return { kind: "git-bash", path: override };
  const found = gitBashCandidates(env, exists).find((candidate) => exists(candidate));
  return found ? { kind: "git-bash", path: found } : { kind: "cmd" };
}

let resolvedShell: CommandShell | null = null;

/** The shell for this process, looked up once. */
export function resolveCommandShell(): CommandShell {
  resolvedShell ??= findCommandShell(process.env, process.platform);
  return resolvedShell;
}

/**
 * One environment line telling the model which shell the bash tool runs, or
 * null where that is the usual /bin/sh.
 */
export function describeCommandShellForModel(shell: CommandShell = resolveCommandShell()): string | null {
  switch (shell.kind) {
    case "posix":
      return null;
    case "git-bash":
      return "Shell: the bash tool runs Git Bash on Windows. Use POSIX shell syntax: /dev/null not NUL, $VAR not %VAR%, forward slashes in paths.";
    case "cmd":
      return (
        "Shell: the bash tool runs cmd.exe (Git Bash was not found). Use cmd syntax: only double quotes quote, %VAR% for variables, NUL for /dev/null, && to chain. " +
        "One line per command — put longer scripts in a file and run it. head, tail, grep, and wc do not exist; use the grep and read_file tools."
      );
  }
}

/** For diagnostics: the shell and where it came from. */
export function describeCommandShell(shell: CommandShell = resolveCommandShell()): {
  ok: boolean;
  summary: string;
  detail: string | null;
} {
  switch (shell.kind) {
    case "posix":
      return { ok: true, summary: "Commands run in /bin/sh.", detail: null };
    case "git-bash":
      return { ok: true, summary: "Commands run in Git Bash.", detail: shell.path };
    case "cmd":
      return {
        ok: false,
        summary: process.env.LIGHTCODE_GIT_BASH_PATH?.trim().toLowerCase() === "off"
          ? "Commands run in cmd.exe (Git Bash turned off by LIGHTCODE_GIT_BASH_PATH)."
          : "Commands run in cmd.exe: Git Bash was not found. Install Git for Windows, or set LIGHTCODE_GIT_BASH_PATH to its bin\\bash.exe.",
        detail: null,
      };
  }
}
