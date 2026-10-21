import { describe, expect, test } from "bun:test";
import { describeCommandShellForModel, findCommandShell } from "./shell";

function existsAmong(...files: string[]) {
  const known = new Set(files.map((file) => file.toLowerCase()));
  return (file: string) => known.has(file.toLowerCase());
}

const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";

describe("findCommandShell", () => {
  test("uses /bin/sh off Windows", () => {
    expect(findCommandShell({}, "linux", () => true)).toEqual({ kind: "posix" });
    expect(findCommandShell({}, "darwin", () => true)).toEqual({ kind: "posix" });
  });

  test("finds Git Bash next to the git.exe on PATH, never WSL's bash", () => {
    const env = {
      Path: "C:\\Windows\\System32;D:\\Tools\\Git\\cmd;C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps",
    };
    const exists = existsAmong(
      "C:\\Windows\\System32\\bash.exe",
      "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe",
      "D:\\Tools\\Git\\cmd\\git.exe",
      "D:\\Tools\\Git\\bin\\bash.exe",
    );
    expect(findCommandShell(env, "win32", exists)).toEqual({
      kind: "git-bash",
      path: "D:\\Tools\\Git\\bin\\bash.exe",
    });
  });

  test("falls back to the usual install folder", () => {
    const env = { PATH: "C:\\Windows\\System32", ProgramFiles: "C:\\Program Files" };
    expect(findCommandShell(env, "win32", existsAmong(gitBash))).toEqual({
      kind: "git-bash",
      path: gitBash,
    });
  });

  test("uses cmd.exe when there is no Git Bash, or when it is turned off", () => {
    const env = { PATH: "C:\\Windows\\System32", ProgramFiles: "C:\\Program Files" };
    expect(findCommandShell(env, "win32", existsAmong())).toEqual({ kind: "cmd" });
    expect(
      findCommandShell({ ...env, LIGHTCODE_GIT_BASH_PATH: "off" }, "win32", existsAmong(gitBash)),
    ).toEqual({ kind: "cmd" });
  });

  test("LIGHTCODE_GIT_BASH_PATH picks the bash.exe", () => {
    const custom = "E:\\PortableGit\\bin\\bash.exe";
    const env = { LIGHTCODE_GIT_BASH_PATH: custom, ProgramFiles: "C:\\Program Files" };
    expect(findCommandShell(env, "win32", existsAmong(custom, gitBash))).toEqual({
      kind: "git-bash",
      path: custom,
    });
  });
});

test("tells the model which shell it is writing for", () => {
  expect(describeCommandShellForModel({ kind: "posix" })).toBeNull();
  expect(describeCommandShellForModel({ kind: "git-bash", path: gitBash })).toContain("Git Bash");
  expect(describeCommandShellForModel({ kind: "cmd" })).toContain("cmd.exe");
});
