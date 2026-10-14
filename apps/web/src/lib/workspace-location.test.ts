import { describe, expect, test } from "bun:test";
import {
  broadWorkspaceRootWarning,
  isSelectableBrowserPath,
  workspaceLocationName,
  workspaceLocationPath,
} from "./workspace-location";
import { shortcutLabel } from "./client-platform";

describe("workspace location labels", () => {
  test("uses server-provided names without assuming Desktop", () => {
    expect(workspaceLocationName({ id: "home", name: "Home", pathLabel: "/Users/dev" })).toBe("Home");
    expect(workspaceLocationName({ id: "projects", label: "Projects" })).toBe("Projects");
    expect(workspaceLocationName({ id: "custom" })).toBe("Local folder");
  });

  test("builds a readable fallback path for any location", () => {
    expect(
      workspaceLocationPath(
        { id: "documents", name: "Documents", pathLabel: "~/Documents" },
        ["client", "site"],
      ),
    ).toBe("~/Documents/client/site");
  });

  test("names the selected broad root in its warning", () => {
    expect(broadWorkspaceRootWarning({ id: "downloads", name: "Downloads" })).toBe(
      "Selecting Downloads lets the agent work inside every folder in Downloads. Choose a project folder for narrower access.",
    );
  });

  test("labels drive paths the Windows way and blocks drive roots", () => {
    const drives = { id: "drives", name: "This PC", pathLabel: "This PC", kind: "drives" };
    expect(workspaceLocationPath(drives, [])).toBe("This PC");
    expect(workspaceLocationPath(drives, ["D:"])).toBe("D:" + "\\");
    expect(workspaceLocationPath(drives, ["D:", "Self-Project", "lightcode"])).toBe(
      ["D:", "Self-Project", "lightcode"].join("\\"),
    );
    expect(isSelectableBrowserPath(drives, [])).toBe(false);
    expect(isSelectableBrowserPath(drives, ["D:"])).toBe(false);
    expect(isSelectableBrowserPath(drives, ["D:", "work"])).toBe(true);
    expect(isSelectableBrowserPath({ id: "home", kind: "known-folder" }, [])).toBe(true);
  });

  test("writes shortcuts for the viewer's platform", () => {
    expect(shortcutLabel({ shift: true, key: "N" }, "Windows")).toBe("Ctrl+Shift+N");
    expect(shortcutLabel({ key: "K" }, "macOS")).toBe("⌘K");
    expect(shortcutLabel({ key: "K" }, "MacIntel")).toBe("⌘K");
  });
});
