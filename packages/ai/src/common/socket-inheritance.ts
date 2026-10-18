/**
 * Windows gives a child process every inheritable handle of its parent, and
 * Bun creates sockets inheritable. A child that outlives Lightcode's server —
 * a `start /B` dev server, an editor or browser opened from a command — then
 * keeps the server's listening socket open, so the port stays taken after the
 * server exits and the next Lightcode cannot start.
 */

const handleFlagInherit = 1;
/** Handle values are multiples of 4; a Bun process stays far below this. */
const maxHandleValue = 1 << 17;

interface WindowsSocketApis {
  isSocket(handle: number): boolean;
  clearInherit(handle: number): void;
}

let apis: Promise<WindowsSocketApis | null> | null = null;

function loadWindowsSocketApis(): Promise<WindowsSocketApis | null> {
  apis ??= (async () => {
    try {
      // A variable specifier keeps browser bundles from resolving bun:ffi.
      const specifier = "bun:ffi";
      const { dlopen, FFIType, ptr } = (await import(specifier)) as typeof import("bun:ffi");
      const winsock = dlopen("ws2_32.dll", {
        getsockname: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      });
      const kernel32 = dlopen("kernel32.dll", {
        SetHandleInformation: { args: [FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
      });
      const address = new Uint8Array(128);
      const length = new Int32Array(1);
      return {
        // getsockname answers only for sockets, so it doubles as the test.
        isSocket(handle) {
          length[0] = address.length;
          return winsock.symbols.getsockname(BigInt(handle), ptr(address), ptr(length)) === 0;
        },
        clearInherit(handle) {
          kernel32.symbols.SetHandleInformation(BigInt(handle), handleFlagInherit, 0);
        },
      };
    } catch {
      return null;
    }
  })();
  return apis;
}

/**
 * Marks every socket this process holds as not inheritable. Call it once the
 * server listens, and again before starting commands (for sockets opened
 * since). Returns how many sockets it found; 0 and a no-op off Windows.
 */
export async function stopSocketInheritance(): Promise<number> {
  if (process.platform !== "win32") return 0;
  const windows = await loadWindowsSocketApis();
  if (!windows) return 0;
  let sockets = 0;
  try {
    for (let handle = 4; handle < maxHandleValue; handle += 4) {
      if (windows.isSocket(handle)) {
        windows.clearInherit(handle);
        sockets += 1;
      }
    }
  } catch {
    // Best effort: a failure here must never block a command or the server.
  }
  return sockets;
}
