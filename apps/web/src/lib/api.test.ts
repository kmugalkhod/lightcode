import { describe, expect, test } from "bun:test";
import {
  createLightcodeApi,
  displaySessionTitle,
  extractLaunchToken,
  formatRelativeTime,
  readLaunchToken,
  requiresBroadWorkspaceConfirmation,
  webTokenStorageKey,
  withBearerToken,
  type AuthenticatedFetch,
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

  test("opens the native picker with a strict empty browser request", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetcher = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input: String(input), init });
        return new Response(
          JSON.stringify({
            outcome: "selected",
            workspace: {
              id: "workspace-1",
              name: "lightcode",
              pathLabel: "C:\\Users\\Kunal\\lightcode",
              createdAt: "2026-08-30T00:00:00.000Z",
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      },
      { preconnect: (() => undefined) as AuthenticatedFetch["preconnect"] },
    ) satisfies AuthenticatedFetch;
    const api = createLightcodeApi(fetcher);

    await expect(api.openWorkspacePicker()).resolves.toMatchObject({
      outcome: "selected",
      workspace: { name: "lightcode" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("/workspaces/picker/open");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe("{}");
  });

  test("preserves native-picker cancellation as a normal outcome", async () => {
    const fetcher = Object.assign(
      async () =>
        new Response(JSON.stringify({ outcome: "cancelled" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      { preconnect: (() => undefined) as AuthenticatedFetch["preconnect"] },
    ) satisfies AuthenticatedFetch;
    const api = createLightcodeApi(fetcher);

    await expect(api.openWorkspacePicker()).resolves.toEqual({
      outcome: "cancelled",
    });
  });
});
