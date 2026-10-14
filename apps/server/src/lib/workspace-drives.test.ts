import { describe, expect, test } from "bun:test";
import {
  listWindowsDrives,
  windowsDriveRoot,
  windowsDriveTokenPattern,
} from "./workspace-drives";

describe("windows drives", () => {
  test("lists present and unresponsive drives, skipping A: and B:", async () => {
    const probed: string[] = [];
    const drives = await listWindowsDrives(async (root) => {
      probed.push(root);
      if (root === "C:\\" || root === "D:\\") return "present";
      if (root === "Z:\\") return "unresponsive";
      return "absent";
    });

    expect(drives).toEqual([
      { token: "C:", readable: true },
      { token: "D:", readable: true },
      { token: "Z:", readable: false },
    ]);
    expect(probed).not.toContain("A:\\");
    expect(probed).not.toContain("B:\\");
    expect(probed).toHaveLength(24);
  });

  test("accepts only single upper-case drive tokens", () => {
    expect(windowsDriveTokenPattern.test("D:")).toBe(true);
    for (const token of ["d:", "D", "DD:", "D:\\", "D:foo", "..", "\\\\server"]) {
      expect(windowsDriveTokenPattern.test(token)).toBe(false);
    }
    expect(windowsDriveRoot("D:")).toBe("D:\\");
  });
});
