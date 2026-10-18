import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const moduleUrl = new URL("./socket-inheritance.ts", import.meta.url).href;

/**
 * Runs a server in a child Bun that starts a long-lived detached process (as
 * `start /B` does) and exits, then reports whether the server's port is
 * still taken afterwards.
 */
async function portStillTakenAfterServerExits(clearInheritance: boolean): Promise<boolean> {
  const directory = await mkdtemp(path.join(tmpdir(), "lightcode-sockets-"));
  const script = path.join(directory, "server.ts");
  await writeFile(
    script,
    [
      `import { spawn } from "node:child_process";`,
      `import { stopSocketInheritance } from ${JSON.stringify(moduleUrl)};`,
      `const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });`,
      clearInheritance ? `await stopSocketInheritance();` : ``,
      `spawn('start /B "" ' + JSON.stringify(process.execPath) + ' -e "setTimeout(() => {}, 8000)"', { shell: true, windowsHide: true, stdio: "ignore" });`,
      `await Bun.sleep(500);`,
      `console.log(server.port);`,
      `process.exit(0);`,
    ].join("\n"),
  );
  try {
    const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "inherit" });
    const port = Number((await new Response(child.stdout).text()).trim());
    await child.exited;
    await Bun.sleep(500);
    try {
      Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("ok") }).stop(true);
      return false;
    } catch {
      return true;
    }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe.skipIf(process.platform !== "win32")("socket inheritance on Windows", () => {
  test("a process the server started no longer keeps its port after it exits", async () => {
    // Without the fix the leftover process holds the port: the bug users hit.
    expect(await portStillTakenAfterServerExits(false)).toBe(true);
    expect(await portStillTakenAfterServerExits(true)).toBe(false);
  }, 30_000);
});
