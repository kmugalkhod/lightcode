import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";

// Exercise the generated Node launcher on every OS without launching Bun or
// touching the host certificate stores. Real TLS verification has separate tests.
const buildScript = readFileSync(new URL("./build-dist.ts", import.meta.url), "utf8");
const template = /const launcherSource = (`[\s\S]*?`);\n\nconst launcherPath/.exec(buildScript)?.[1];
if (!template) throw new Error("Cannot find launcher template");
const launcher: string = runInNewContext(template);

function simulateWindows({ existingCa, exportFails = false, childStatus = 0 }: { existingCa?: string; exportFails?: boolean; childStatus?: number | null } = {}) {
  const writes = new Map<string, string>();
  const removed: string[] = [];
  const spawned: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const env: Record<string, string> = existingCa ? { NODE_EXTRA_CA_CERTS: existingCa } : {};
  const handlers: Array<() => void> = [];
  let exitCode: number | undefined;
  const fs = {
    existsSync: () => true,
    mkdtempSync: (prefix: string) => `${prefix}unique`,
    writeFileSync: (file: string, content: string) => writes.set(file, content),
    readdirSync: () => ["0.cer"],
    readFileSync: () => Buffer.from("test DER certificate"),
    unlinkSync: () => {},
    rmSync: (file: string) => removed.push(file),
  };
  const requireMock = (name: string) => {
    if (name === "fs") return fs;
    if (name === "path") return path;
    if (name === "os") return { tmpdir: () => "/virtual-temp" };
    if (name === "child_process") return {
      spawnSync(command: string, args: string[], options: Record<string, unknown> = {}) {
        spawned.push({ command, args, options });
        if (args[0] === "--version") return { status: 0, stdout: "1.3.14" };
        if (command === "powershell") return { status: exportFails ? 1 : 0 };
        return { status: childStatus };
      },
    };
    throw new Error(`Unexpected module ${name}`);
  };
  runInNewContext(launcher, {
    require: requireMock, __dirname: "/virtual-app", console,
    process: {
      platform: "win32", env, argv: ["node", "lightcode"],
      on: (_event: string, callback: () => void) => handlers.push(callback),
      exit: (code: number) => { exitCode = code; },
    },
  });
  handlers.forEach((callback) => callback());
  return { writes, removed, spawned, env, exitCode };
}

describe("packaged Windows launcher", () => {
  test("exports both trusted root stores with a bounded, isolated PowerShell process", () => {
    const result = simulateWindows();
    const script = [...result.writes.entries()].find(([file]) => file.endsWith("export.ps1"))?.[1];
    expect(script).toContain('"LocalMachine", "CurrentUser"');
    expect(script).toContain("Root");
    expect(script).toContain("$env:LIGHTCODE_CERT_EXPORT_DIR");
    expect(result.spawned.find((call) => call.command === "powershell")?.options.timeout).toBe(10_000);
    expect(result.env.NODE_EXTRA_CA_CERTS).toEndWith("ca.pem");
    expect(result.removed).toEqual([path.join("/virtual-temp", "lightcode-certs-unique")]);
    expect(result.exitCode).toBe(0);
  });

  test("preserves explicit CA configuration", () => {
    const result = simulateWindows({ existingCa: "/company/ca.pem" });
    expect(result.spawned.some((call) => call.command === "powershell")).toBe(false);
    expect(result.env.NODE_EXTRA_CA_CERTS).toBe("/company/ca.pem");
  });

  test("failed exports do not load stale certificates", () => {
    const result = simulateWindows({ exportFails: true });
    expect(result.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(result.removed).toHaveLength(1);
  });

  test("a child terminated without an exit status is not reported as success", () => {
    expect(simulateWindows({ childStatus: null }).exitCode).toBe(1);
  });
});
