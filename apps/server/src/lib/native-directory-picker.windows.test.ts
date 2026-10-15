import { describe, expect, test } from "bun:test";
import {
  createNativeDirectoryPicker,
  runNativePickerProcess,
} from "./native-directory-picker";

const showDialogMarker = "# lightcode:show-dialog";
const skipSmoke =
  process.platform !== "win32" || Bun.env.LIGHTCODE_SKIP_PICKER_SMOKE === "1";

/**
 * Default-on for win32: stubbed runners never execute the PowerShell script,
 * which is how an unsupported FolderBrowserDialog property shipped. This runs
 * the production script, flags, and spawner for real, stopping just before
 * ShowDialog so no window opens. Set LIGHTCODE_SKIP_PICKER_SMOKE=1 to skip.
 */
describe("windows native directory picker prologue", () => {
  test.skipIf(skipSmoke)(
    "runs the real script up to ShowDialog without errors",
    async () => {
      let argv: string[] = [];
      const picker = createNativeDirectoryPicker({
        platform: "win32",
        runProcess: async (command) => {
          argv = [...command];
          return { exitCode: 0, stdout: "cancelled", stderr: "" };
        },
      });
      await expect(picker.pick()).resolves.toEqual({ outcome: "cancelled" });

      const encodedIndex = argv.indexOf("-EncodedCommand") + 1;
      expect(encodedIndex).toBeGreaterThan(0);
      const script = Buffer.from(argv[encodedIndex] ?? "", "base64").toString(
        "utf16le",
      );
      const markerIndex = script.indexOf(showDialogMarker);
      expect(markerIndex).toBeGreaterThan(0);

      const prologue = `${script.slice(0, markerIndex)}
[Console]::Out.Write('prologue-ok:' + [bool]$owner + ':' + $modernPicker)
$owner.Dispose()
`;
      const smokeArgv = [...argv];
      smokeArgv[encodedIndex] = Buffer.from(prologue, "utf16le").toString(
        "base64",
      );

      const result = await runNativePickerProcess(smokeArgv).catch((error) => {
        // EPERM here means Windows refused to start PowerShell at all (seen
        // intermittently with Defender scanning repeated launches). That says
        // nothing about the script, so name the cause instead of a stack.
        if (Reflect.get(error, "code") === "EPERM") {
          throw new Error(
            "Windows refused to start powershell.exe (EPERM). Security software may be blocking it; " +
              "retry, or set LIGHTCODE_SKIP_PICKER_SMOKE=1 on this machine.",
          );
        }
        throw error;
      });
      expect({ ...result, stderr: result.stderr.trim() }).toEqual({
        exitCode: 0,
        stdout: "prologue-ok:True:True",
        stderr: "",
      });
    },
    90_000,
  );
});
