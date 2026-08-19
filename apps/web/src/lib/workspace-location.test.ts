import { describe, expect, test } from "bun:test";
import {
  broadWorkspaceRootWarning,
  workspaceLocationName,
  workspaceLocationPath,
} from "./workspace-location";

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
});
