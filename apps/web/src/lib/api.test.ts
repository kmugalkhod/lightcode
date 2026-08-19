import { describe, expect, test } from "bun:test";
import {
  displaySessionTitle,
  extractLaunchToken,
  formatRelativeTime,
  readLaunchToken,
  requiresBroadWorkspaceConfirmation,
  webTokenStorageKey,
  withBearerToken,
  type StorageLike,
} from "./api";

function memoryStorage(seed: Record<string, string> = {}): StorageLike {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe("web launch authentication", () => {
  test("reads named and compact fragment tokens", () => {
    expect(extractLaunchToken("#token=launch-secret")).toBe("launch-secret");
    expect(extractLaunchToken("#compact-secret")).toBe("compact-secret");
    expect(extractLaunchToken("#route=app")).toBeNull();
  });

  test("fragment token replaces the prior session token", () => {
    const storage = memoryStorage({ [webTokenStorageKey]: "stale" });
    expect(readLaunchToken({ fragment: "#token=fresh", storage })).toEqual({
      token: "fresh",
      fromFragment: true,
    });
    expect(storage.getItem(webTokenStorageKey)).toBe("fresh");
  });

  test("adds authorization without mutating the input headers", () => {
    const input = new Headers({ Accept: "application/json" });
    const output = withBearerToken("secret", input);
    expect(output.get("authorization")).toBe("Bearer secret");
    expect(output.get("accept")).toBe("application/json");
    expect(input.has("authorization")).toBe(false);
  });
});

describe("session labels", () => {
  test("prefers a title and falls back to the latest prompt", () => {
    const base = {
      title: null,
      cwd: "/workspace",
      mode: "build" as const,
      permissionMode: "workspace-write" as const,
      model: null,
      revision: 0,
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
    };
    expect(displaySessionTitle({ ...base, id: "a", title: "Fix parser" })).toBe("Fix parser");
    expect(displaySessionTitle({ ...base, id: "b", latestUserPromptPreview: "Add tests" })).toBe("Add tests");
  });

  test("formats compact relative time", () => {
    const now = Date.parse("2026-08-19T12:00:00.000Z");
    expect(formatRelativeTime("2026-08-19T11:59:40.000Z", now)).toBe("now");
    expect(formatRelativeTime("2026-08-19T11:52:00.000Z", now)).toBe("8m");
    expect(formatRelativeTime("2026-08-17T12:00:00.000Z", now)).toBe("2d");
  });
});

describe("workspace selection", () => {
  test("requires explicit confirmation for any broad location root", () => {
    expect(requiresBroadWorkspaceConfirmation([])).toBe(true);
    expect(requiresBroadWorkspaceConfirmation(["lightcode"])).toBe(false);
  });
});
