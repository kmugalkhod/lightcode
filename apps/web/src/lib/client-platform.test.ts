import { describe, expect, test } from "bun:test";
import { shortcutLabel, systemFolderDialogLabel } from "./client-platform";

describe("client platform labels", () => {
  test("names the OS folder dialog the way each platform calls it", () => {
    expect(systemFolderDialogLabel("Win32")).toBe("Use Windows dialog");
    expect(systemFolderDialogLabel("MacIntel")).toBe("Use Finder");
    expect(systemFolderDialogLabel("Linux x86_64")).toBe("Use system dialog");
  });

  test("formats shortcuts per platform", () => {
    expect(shortcutLabel({ key: "B" }, "Win32")).toBe("Ctrl+B");
    expect(shortcutLabel({ shift: true, key: "N" }, "MacIntel")).toBe("⌘⇧N");
  });
});
