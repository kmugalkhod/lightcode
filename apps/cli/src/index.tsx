#!/usr/bin/env bun
import { lightcodeVersion, productName } from "@lightcode/shared";

const cliArgs = Bun.argv.slice(2);
if (cliArgs.includes("--version") || cliArgs.includes("-v")) {
  console.log(`${productName} v${lightcodeVersion}`);
  process.exit(0);
}

const { ensureServerRunning } = await import("./lib/server-launcher");
const serverLaunch = await ensureServerRunning();

if (serverLaunch.error) {
  console.error(`\n${serverLaunch.error}\n`);
  process.exit(1);
}

const { createCliRenderer } = await import("@opentui/core");
const { createRoot } = await import("@opentui/react");
const { App } = await import("./app");

const renderer = await createCliRenderer({
  // We own Ctrl+C in app.tsx (copy selection / "press again to exit"); the
  // renderer must not hard-quit on it. Ctrl+Q remains an immediate quit.
  exitOnCtrlC: false,
});

if (serverLaunch.ownedProcess) {
  const ownedProcess = serverLaunch.ownedProcess;
  const killOwnedServer = () => {
    try {
      ownedProcess.kill();
    } catch {
      // The server may already be gone.
    }
  };
  process.on("exit", killOwnedServer);
  // process.on("exit") does not fire on signals; tear the server down on a
  // clean Ctrl+C/terminate too (the server's parent-death watchdog is the
  // backstop for SIGKILL/terminal-close).
  process.on("SIGINT", () => {
    killOwnedServer();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    killOwnedServer();
    process.exit(0);
  });
}

createRoot(renderer).render(<App />);
