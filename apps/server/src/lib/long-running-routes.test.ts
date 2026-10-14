import { describe, expect, test } from "bun:test";
import { createServerFetch, isLongRunningRoute } from "./long-running-routes";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function request(method: string, pathname: string) {
  return new Request(`http://127.0.0.1${pathname}`, { method });
}

describe("isLongRunningRoute", () => {
  test("exempts chat streams and the native folder picker", () => {
    expect(isLongRunningRoute(request("POST", "/sessions/abc/chat"))).toBe(true);
    expect(isLongRunningRoute(request("POST", "/sessions/abc/turns"))).toBe(true);
    expect(isLongRunningRoute(request("POST", "/workspaces/picker/open"))).toBe(
      true,
    );
  });

  test("keeps the idle timeout for every other route", () => {
    expect(isLongRunningRoute(request("GET", "/workspaces/picker/open"))).toBe(
      false,
    );
    expect(isLongRunningRoute(request("POST", "/workspaces/browser/open"))).toBe(
      false,
    );
    expect(isLongRunningRoute(request("POST", "/workspaces/picker/open/x"))).toBe(
      false,
    );
    expect(isLongRunningRoute(request("GET", "/sessions/abc/chat"))).toBe(false);
    expect(isLongRunningRoute(request("POST", "/sessions"))).toBe(false);
  });
});

describe("createServerFetch", () => {
  test("a slow picker request outlives the idle timeout; other routes do not", async () => {
    const slowApp = {
      async fetch() {
        // Bun sweeps idle sockets roughly every 4 s, so 1 s closes at about 4 s.
        await sleep(6_000);
        return new Response("done");
      },
    };
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 1,
      fetch: createServerFetch(slowApp),
    });
    try {
      const picker = fetch(`${server.url}workspaces/picker/open`, {
        method: "POST",
      });
      const other = fetch(`${server.url}workspaces/browser/open`, {
        method: "POST",
      })
        .then((response) => response.text())
        .then(
          () => "completed",
          () => "closed",
        );

      const pickerResponse = await picker;
      expect(await pickerResponse.text()).toBe("done");
      expect(await other).toBe("closed");
    } finally {
      await server.stop(true);
    }
  }, 15_000);
});
