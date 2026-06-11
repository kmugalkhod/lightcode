#!/usr/bin/env bun
import { lightcodeVersion, productName } from "@lightcode/shared";

const cliArgs = Bun.argv.slice(2);
if (cliArgs.includes("--version") || cliArgs.includes("-v")) {
  console.log(`${productName} v${lightcodeVersion}`);
  process.exit(0);
}

const { ensureServerRunning } = await import("./lib/server-launcher");
const serverLaunch = await ensureServerRunning();

const { createCliRenderer } = await import("@opentui/core");
const { createRoot } = await import("@opentui/react");
const { App } = await import("./app");

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
});

if (serverLaunch.ownedProcess) {
  const ownedProcess = serverLaunch.ownedProcess;
  process.on("exit", () => {
    try {
      ownedProcess.kill();
    } catch {
      // The server may already be gone.
    }
  });
}

createRoot(renderer).render(<App />);
