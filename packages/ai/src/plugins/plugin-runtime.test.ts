import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listPlugins, runPluginHooks } from "./runtime";

const tempRoots: string[] = [];

function createTempWorkspace() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "lightcode-plugins-"));
  tempRoots.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("plugin manifests and hooks", () => {
  test("lists local plugin manifests and keeps hooks disabled by default", async () => {
    const cwd = createTempWorkspace();
    const pluginDir = path.join(cwd, ".lightcode", "plugins", "demo");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo Plugin",
        hooks: [
          {
            event: "PreToolUse",
            command: "node",
            args: ["hook.js"],
          },
        ],
      }),
    );

    expect(listPlugins({ cwd })).toEqual([
      {
        id: "demo",
        name: "Demo Plugin",
        version: null,
        description: null,
        enabled: true,
        path: path.join(pluginDir, "plugin.json"),
        hookCount: 1,
      },
    ]);

    const result = await runPluginHooks({ event: "PreToolUse", cwd });
    expect(result.result).toBe("allow");
    expect(result.hooksRun).toBe(0);
    expect(result.skipped).toBe(1);
  });
});
