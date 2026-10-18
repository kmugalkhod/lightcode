import { describe, expect, test } from "bun:test";
import path from "node:path";
import { describeSearchEngine, resolveRipgrep, withBundledRipgrepOnPath } from "./ripgrep";

describe("bundled ripgrep", () => {
  test("is found without any install step, and LIGHTCODE_RIPGREP can override or turn it off", async () => {
    const bundled = await resolveRipgrep({});
    expect(bundled?.source).toBe("bundled");
    expect(path.basename(bundled!.path)).toBe(process.platform === "win32" ? "rg.exe" : "rg");

    expect(await resolveRipgrep({ LIGHTCODE_RIPGREP: "off" })).toBeNull();
    expect(await resolveRipgrep({ LIGHTCODE_RIPGREP: "/opt/rg" })).toEqual({ path: "/opt/rg", source: "env" });
    expect((await describeSearchEngine({ LIGHTCODE_RIPGREP: "off" })).ripgrep).toBe(false);
  });

  test("is appended to the shell PATH once, under the existing variable's spelling", async () => {
    const bundledDirectory = path.dirname((await resolveRipgrep({}))!.path);
    const windowsStyle = await withBundledRipgrepOnPath({ Path: ["/usr/bin", "/bin"].join(path.delimiter) });
    expect(Object.keys(windowsStyle)).toEqual(["Path"]);
    expect(windowsStyle.Path!.split(path.delimiter)).toEqual(["/usr/bin", "/bin", bundledDirectory]);

    const again = await withBundledRipgrepOnPath(windowsStyle);
    expect(again.Path).toBe(windowsStyle.Path);
  });
});
