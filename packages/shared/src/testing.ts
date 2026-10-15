import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Whether this process may create file symlinks. Windows allows it only with
 * Developer Mode or elevation, so symlink-escape tests run where the OS lets
 * them instead of being skipped on every Windows machine.
 */
export const canCreateFileSymlinks: boolean = (() => {
  const directory = mkdtempSync(path.join(tmpdir(), "lightcode-symlink-probe-"));
  try {
    const target = path.join(directory, "target.txt");
    writeFileSync(target, "probe");
    symlinkSync(target, path.join(directory, "link.txt"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
})();
