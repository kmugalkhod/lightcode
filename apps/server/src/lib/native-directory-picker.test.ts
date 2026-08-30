import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import {
  createNativeDirectoryPicker,
  NativeDirectoryPickerError,
  runNativePickerProcess,
  type NativePickerProcessResult,
} from "./native-directory-picker";

const cancelledProcess: NativePickerProcessResult = {
  exitCode: 0,
  stdout: "cancelled",
  stderr: "",
};

describe("native directory picker", () => {
  test("uses an absolute encoded PowerShell command and decodes Unicode paths", async () => {
    const selected = "D:\\Work trees\\café";
    let command: readonly string[] = [];
    const picker = createNativeDirectoryPicker({
      platform: "win32",
      environment: { SystemRoot: "C:\\Windows" },
      which: (candidate) => candidate,
      runProcess: async (argv) => {
        command = argv;
        return {
          exitCode: 0,
          stdout: `selected:${Buffer.from(selected, "utf8").toString("base64")}`,
          stderr: "",
        };
      },
    });

    await expect(picker.pick()).resolves.toEqual({
      outcome: "selected",
      directory: selected,
    });
    expect(command[0]).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(command).toContain("-STA");
    const encodedIndex = command.indexOf("-EncodedCommand") + 1;
    expect(encodedIndex).toBeGreaterThan(0);
    const decodedScript = Buffer.from(
      command[encodedIndex] ?? "",
      "base64",
    ).toString("utf16le");
    expect(decodedScript).toContain("FolderBrowserDialog");
    expect(decodedScript).toContain("$owner.Activate()");
    expect(decodedScript).not.toContain("WindowState]::Minimized");
  });

  test("treats Windows, macOS, and Linux cancellation as a normal outcome", async () => {
    const windows = createNativeDirectoryPicker({
      platform: "win32",
      environment: { SystemRoot: "C:\\Windows" },
      which: (candidate) => candidate,
      runProcess: async () => cancelledProcess,
    });
    const macos = createNativeDirectoryPicker({
      platform: "darwin",
      which: (candidate) => candidate,
      runProcess: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "execution error: User canceled. (-128)",
      }),
    });
    const linux = createNativeDirectoryPicker({
      platform: "linux",
      environment: { DISPLAY: ":0" },
      which: (candidate) =>
        candidate === "/usr/bin/zenity" ? candidate : null,
      runProcess: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    });

    await expect(windows.pick()).resolves.toEqual({ outcome: "cancelled" });
    await expect(macos.pick()).resolves.toEqual({ outcome: "cancelled" });
    await expect(linux.pick()).resolves.toEqual({ outcome: "cancelled" });
  });

  test("preserves spaces while removing only the picker-added line ending", async () => {
    const picker = createNativeDirectoryPicker({
      platform: "darwin",
      which: (candidate) => candidate,
      runProcess: async () => ({
        exitCode: 0,
        stdout: "/Users/lightcode/Project with trailing space \n",
        stderr: "",
      }),
    });

    await expect(picker.pick()).resolves.toEqual({
      outcome: "selected",
      directory: "/Users/lightcode/Project with trailing space ",
    });
  });

  test("rejects a Windows path rooted only on the process drive", async () => {
    const picker = createNativeDirectoryPicker({
      platform: "win32",
      environment: { SystemRoot: "C:\\Windows" },
      which: (candidate) => candidate,
      runProcess: async () => ({
        exitCode: 0,
        stdout: `selected:${Buffer.from("\\project", "utf8").toString("base64")}`,
        stderr: "",
      }),
    });

    await expect(picker.pick()).rejects.toMatchObject({
      code: "native_picker_failed",
    });
  });

  test("prefers the current Linux desktop and falls back to the other picker", async () => {
    const commands: string[][] = [];
    const kde = createNativeDirectoryPicker({
      platform: "linux",
      environment: { DISPLAY: ":0", XDG_CURRENT_DESKTOP: "KDE" },
      which: (candidate) =>
        candidate === "/usr/bin/kdialog" ? candidate : null,
      runProcess: async (command) => {
        commands.push([...command]);
        return { exitCode: 0, stdout: "/work/project\n", stderr: "" };
      },
    });
    await kde.pick();
    expect(commands[0]?.[0]).toBe("/usr/bin/kdialog");
    expect(commands[0]?.at(-1)).toBe(homedir());

    const fallback = createNativeDirectoryPicker({
      platform: "linux",
      environment: { WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "GNOME" },
      which: (candidate) =>
        candidate === "/usr/bin/kdialog" ? candidate : null,
      runProcess: async (command) => {
        commands.push([...command]);
        return { exitCode: 0, stdout: "/work/other\n", stderr: "" };
      },
    });
    await fallback.pick();
    expect(commands[1]?.[0]).toBe("/usr/bin/kdialog");
    expect(commands[1]?.at(-1)).toBe(homedir());
  });

  test("resolves Linux pickers only from fixed system locations", async () => {
    const candidates: string[] = [];
    let command: readonly string[] = [];
    const picker = createNativeDirectoryPicker({
      platform: "linux",
      environment: { DISPLAY: ":0" },
      which: (candidate) => {
        candidates.push(candidate);
        return candidate === "/usr/bin/zenity" ? candidate : null;
      },
      runProcess: async (argv) => {
        command = argv;
        return { exitCode: 0, stdout: "/work/project\n", stderr: "" };
      },
    });

    await picker.pick();
    expect(command[0]).toBe("/usr/bin/zenity");
    expect(candidates.every((candidate) => candidate.startsWith("/"))).toBe(true);
    expect(candidates.join("\n")).not.toContain("node_modules");
  });

  test("reports unavailable platforms without starting a process", async () => {
    let processCalls = 0;
    const picker = createNativeDirectoryPicker({
      platform: "linux",
      environment: { DISPLAY: ":0" },
      which: () => null,
      runProcess: async () => {
        processCalls += 1;
        return cancelledProcess;
      },
    });

    await expect(picker.pick()).rejects.toMatchObject({
      code: "native_picker_unavailable",
    });
    expect(processCalls).toBe(0);

    const headlessPicker = createNativeDirectoryPicker({
      platform: "linux",
      environment: {},
      which: (command) => `/usr/bin/${command}`,
      runProcess: async () => {
        processCalls += 1;
        return cancelledProcess;
      },
    });
    await expect(headlessPicker.pick()).rejects.toMatchObject({
      code: "native_picker_unavailable",
    });
    expect(processCalls).toBe(0);
  });

  test("rejects overlapping dialogs and releases the gate after completion", async () => {
    let finish: ((result: NativePickerProcessResult) => void) | undefined;
    const picker = createNativeDirectoryPicker({
      platform: "darwin",
      which: (candidate) => candidate,
      runProcess: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });

    const first = picker.pick();
    await expect(picker.pick()).rejects.toMatchObject({
      code: "native_picker_busy",
    });
    finish?.({ exitCode: 1, stdout: "", stderr: "User canceled (-128)" });
    await expect(first).resolves.toEqual({ outcome: "cancelled" });
    const next = picker.pick();
    finish?.({ exitCode: 1, stdout: "", stderr: "User canceled (-128)" });
    await expect(next).resolves.toEqual({ outcome: "cancelled" });
  });

  test("does not spawn for a pre-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    let processCalls = 0;
    const picker = createNativeDirectoryPicker({
      platform: "darwin",
      which: (candidate) => candidate,
      runProcess: async () => {
        processCalls += 1;
        return cancelledProcess;
      },
    });

    await expect(picker.pick(controller.signal)).resolves.toEqual({
      outcome: "cancelled",
    });
    expect(processCalls).toBe(0);
  });

  test("fails closed without exposing process output", async () => {
    const secretPath = "/private/secret-project";
    const picker = createNativeDirectoryPicker({
      platform: "darwin",
      which: (candidate) => candidate,
      runProcess: async () => ({
        exitCode: 2,
        stdout: secretPath,
        stderr: `failure near ${secretPath}`,
      }),
    });

    try {
      await picker.pick();
      throw new Error("expected picker failure");
    } catch (error) {
      expect(error).toBeInstanceOf(NativeDirectoryPickerError);
      expect(error).toMatchObject({ code: "native_picker_failed" });
      expect(String(error)).not.toContain(secretPath);
    }
  });

  test("bounds production process output and kills an aborted picker", async () => {
    await expect(
      runNativePickerProcess([
        process.execPath,
        "-e",
        "process.stdout.write('x'.repeat(20000))",
      ]),
    ).rejects.toMatchObject({ code: "native_picker_failed" });

    const controller = new AbortController();
    const pending = runNativePickerProcess(
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      controller.signal,
    );
    setTimeout(() => controller.abort(), 20);
    await expect(pending).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "",
    });
  });
});
