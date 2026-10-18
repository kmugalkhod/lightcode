import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const isWindows = process.platform === "win32";
/** POSIX grace period between SIGTERM and SIGKILL when stopping a tree. */
const terminateGraceMs = 2_000;
/** When Windows terminates the shell itself if taskkill has not finished. */
const windowsTreeKillFallbackMs = 2_000;
/**
 * How long to wait for the output pipes to close after the shell exits. A
 * grandchild the command left running (`cmd &`, `start /B`) inherits the pipes
 * and would otherwise hold the call open until it dies.
 */
const pipeDrainGraceMs = 1_000;

/**
 * Starts `command` in the same shell `child_process.exec` uses (cmd.exe on
 * Windows, /bin/sh elsewhere). Stdin is closed so a command that prompts reads
 * EOF instead of hanging until its timeout. On POSIX the shell leads its own
 * process group so a stop reaches everything it started.
 */
export function spawnShellCommand(command: string, cwd: string): ChildProcess {
  const child = spawn(command, {
    cwd,
    shell: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: !isWindows,
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  return child;
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * Stops a command and every process it started. `sync` is for process-exit
 * handlers, where nothing asynchronous runs.
 */
export function killProcessTree(
  child: ChildProcess,
  { sync = false }: { sync?: boolean } = {},
): void {
  const pid = child.pid;
  if (pid === undefined || !isRunning(child)) {
    return;
  }

  if (isWindows) {
    const args = ["/pid", String(pid), "/T", "/F"];
    if (sync) {
      spawnSync("taskkill", args, { windowsHide: true, stdio: "ignore" });
      return;
    }
    spawn("taskkill", args, { windowsHide: true, stdio: "ignore" }).on(
      "error",
      () => child.kill(),
    );
    // taskkill takes ~1s idle and longer under load; never let a slow one
    // hold the call open. Its tree snapshot is long taken by then.
    const fallback = setTimeout(() => {
      if (isRunning(child)) child.kill();
    }, windowsTreeKillFallbackMs);
    fallback.unref();
    return;
  }

  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  if (sync) {
    signalGroup("SIGKILL");
    return;
  }
  signalGroup("SIGTERM");
  const escalate = setTimeout(() => {
    if (isRunning(child)) signalGroup("SIGKILL");
  }, terminateGraceMs);
  escalate.unref();
}

/**
 * Resolves with the exit code once the command has exited and its output has
 * drained, or shortly after exit when a leftover grandchild keeps the pipes
 * open (the pipes are then released so the call can return).
 */
export function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (drainTimer) clearTimeout(drainTimer);
      resolve(code);
    };
    child.once("close", (code) => finish(code));
    child.once("error", () => finish(child.exitCode ?? 1));
    child.once("exit", (code) => {
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code);
      }, pipeDrainGraceMs);
      drainTimer.unref();
    });
  });
}

/**
 * Keeps a command's whole output while it fits, otherwise its beginning and
 * its most recent end, so a very noisy command cannot exhaust memory.
 */
export class HeadTailOutput {
  private head = "";
  private tail = "";
  private droppedMiddle = false;

  constructor(private readonly halfLimit: number) {}

  append(chunk: string): void {
    let rest = chunk;
    const room = this.halfLimit - this.head.length;
    if (room > 0) {
      this.head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (!rest) return;
    this.tail += rest;
    // Trim in batches so appends stay cheap.
    if (this.tail.length > this.halfLimit * 2) {
      this.tail = this.tail.slice(-this.halfLimit);
      this.droppedMiddle = true;
    }
  }

  get truncated(): boolean {
    return this.droppedMiddle || this.tail.length > this.halfLimit;
  }

  toString(): string {
    if (!this.truncated) return this.head + this.tail;
    return `${this.head}\n\n... [output truncated] ...\n\n${this.tail.slice(-this.halfLimit)}`;
  }
}

/**
 * The most recent output of a long-running command, addressed by absolute
 * character offsets so a reader can ask for everything after its last read.
 */
export class RollingOutput {
  private buffer = "";
  private start = 0;

  constructor(private readonly capacity: number) {}

  append(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > this.capacity * 2) {
      const drop = this.buffer.length - this.capacity;
      this.buffer = this.buffer.slice(drop);
      this.start += drop;
    }
  }

  /** Absolute offset just past the newest character. */
  get end(): number {
    return this.start + this.buffer.length;
  }

  /** Output after `offset`; `skipped` counts characters already discarded. */
  readFrom(offset: number): { text: string; skipped: number } {
    const oldestKept = Math.max(this.start, this.end - this.capacity);
    const from = Math.max(offset, oldestKept);
    return {
      text: this.buffer.slice(from - this.start),
      skipped: from - offset,
    };
  }
}
