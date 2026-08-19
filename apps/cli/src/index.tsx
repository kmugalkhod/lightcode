#!/usr/bin/env bun
import { lightcodeVersion, productName } from "@lightcode/shared";

const cliArgs = Bun.argv.slice(2);
if (cliArgs.includes("--version") || cliArgs.includes("-v")) {
  console.log(`${productName} v${lightcodeVersion}`);
  process.exit(0);
}

if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
  console.log(`Usage:
  lightcode                 Open the terminal UI
  lightcode web             Open the localhost browser UI
  lightcode web --no-open   Start the browser UI without opening a tab
  lightcode --version       Print the installed version`);
  process.exit(0);
}

const webMode = cliArgs[0] === "web" || cliArgs.includes("--web");
if (webMode) {
  const { startAuthenticatedWebServer } = await import("./lib/server-launcher");
  const { buildWebAppUrl, openWebApp } = await import("./lib/web-launcher");
  const webLaunch = await startAuthenticatedWebServer();

  if (webLaunch.error || !webLaunch.ownedProcess || !webLaunch.token) {
    console.error(`\n${webLaunch.error ?? "Unable to start Lightcode web."}\n`);
    process.exit(1);
  }

  const webUrl = buildWebAppUrl(webLaunch.url, webLaunch.token);
  const shouldOpen = !cliArgs.includes("--no-open");
  const browserOpened = shouldOpen ? openWebApp(webUrl) : false;
  if (shouldOpen && !browserOpened) {
    console.warn("The browser could not be opened automatically.");
  }

  console.log(`Lightcode web is running at ${webLaunch.url}/app/`);
  if (!shouldOpen || !browserOpened) {
    console.log(webUrl);
  }
  console.log("Press Ctrl+C to stop it.");

  const ownedProcess = webLaunch.ownedProcess;
  const stopWebServer = () => {
    try {
      ownedProcess.kill();
    } catch {
      // It may already have stopped.
    }
  };
  process.on("SIGINT", stopWebServer);
  process.on("SIGTERM", stopWebServer);
  const exitCode = await ownedProcess.exited;
  process.exit(exitCode);
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
  // Mouse reporting powers click-to-select copy and the Changes-panel toggle
  // button. It defaults to true; set explicitly so the dependency is obvious.
  useMouse: true,
});

// Register any bundled extra tree-sitter grammars (python, go, rust, …) so the
// file viewer / diffs highlight them. Fail-closed and non-blocking: absent or
// broken grammars are skipped, and the wasm loads lazily on first use.
try {
  const { registerExtraGrammars } = await import("./ui/register-grammars");
  registerExtraGrammars();
} catch {
  // Highlighting is cosmetic — never let grammar setup block startup.
}

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
