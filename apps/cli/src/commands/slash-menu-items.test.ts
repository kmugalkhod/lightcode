import { describe, expect, test } from "bun:test";
import { getSlashMenuItems } from "./slash-menu-items";
import { getSlashPageRoutes } from "../navigation/route-registry";
import { filterChatSlashActions } from "./chat-slash-actions";

describe("getSlashPageRoutes", () => {
  test("returns all routes for an empty query", () => {
    expect(getSlashPageRoutes("/").length).toBeGreaterThan(0);
  });

  test("filters by shortcut prefix", () => {
    const routes = getSlashPageRoutes("/sess");
    expect(routes.map((route) => route.id)).toEqual(["sessions"]);
  });

  test("does not match on descriptions", () => {
    // "session" appears in the /latest description; prefix+label matching
    // must not surface it.
    const routes = getSlashPageRoutes("/saved");
    expect(routes).toEqual([]);
  });
});

describe("filterChatSlashActions", () => {
  test("matches /skill to the skills action only", () => {
    const actions = filterChatSlashActions("/skill");
    expect(actions.map((action) => action.id)).toEqual(["skills"]);
  });

  test("does not match on descriptions", () => {
    // "clipboard" appears in the /copy description.
    expect(filterChatSlashActions("/clipboard")).toEqual([]);
  });
});

describe("getSlashMenuItems", () => {
  test("never returns two items with the same shortcut", () => {
    const items = getSlashMenuItems("/", { host: "chat" });
    const shortcuts = items.map((item) => item.shortcut);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  test("filters both chat actions and routes", () => {
    const items = getSlashMenuItems("/co", { host: "chat" });
    const shortcuts = items.map((item) => item.shortcut).sort();
    expect(shortcuts).toEqual(["/compact", "/config", "/copy"]);
  });

  test("home offers only home-eligible actions plus routes", () => {
    const items = getSlashMenuItems("/", { host: "home" });
    const actionIds = items
      .filter((item) => !("path" in item))
      .map((item) => item.id);
    expect(actionIds).toEqual(["permission"]);
  });

  test("other hosts get routes only", () => {
    const items = getSlashMenuItems("/permission", { host: "other" });
    expect(items.every((item) => "path" in item)).toBe(true);
  });
});
