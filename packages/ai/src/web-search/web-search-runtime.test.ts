import { describe, expect, test } from "bun:test";
import { defaultWebSearchConfig } from "./config";
import { clearWebSearchTurnUses, executeWebSearch } from "./runtime";

describe("web_search runtime", () => {
  test("returns a structured not-configured error when no local provider is available", async () => {
    const output = await executeWebSearch(
      { query: "Lightcode CLI" },
      {
        config: defaultWebSearchConfig,
        credentials: {},
        env: {},
      },
    );

    expect(output.ok).toBe(false);
    expect(output.error?.code).toBe("not_configured");
    expect(output.results).toEqual([]);
  });

  test("uses configured limits, environment credentials, and bounded snippets", async () => {
    let requestedUrl = "";
    let requestedKey = "";
    const output = await executeWebSearch(
      { query: "Lightcode CLI" },
      {
        config: {
          ...defaultWebSearchConfig,
          backend: "brave",
          maxResults: 2,
          maxCharactersPerResult: 12,
        },
        credentials: { braveSearchApiKey: "stored-key" },
        env: { BRAVE_SEARCH_API_KEY: "environment-key" },
        fetch: async (input, init) => {
          requestedUrl = String(input);
          requestedKey = new Headers(init?.headers).get("x-subscription-token") ?? "";
          return Response.json({
            web: {
              results: [
                {
                  title: "Lightcode",
                  url: "https://example.test/lightcode",
                  description: "A deliberately long search result snippet.",
                  profile: "example.test",
                },
                {
                  title: "Repository",
                  url: "https://example.test/repository",
                  description: "Repository result",
                },
                {
                  title: "Ignored",
                  url: "https://example.test/ignored",
                  description: "Third result",
                },
              ],
            },
          });
        },
      },
    );

    expect(requestedUrl).toContain("count=2");
    expect(requestedKey).toBe("environment-key");
    expect(output.ok).toBe(true);
    expect(output.results).toHaveLength(2);
    expect(output.results[0]?.snippet).toBe("A deliberat…");
  });

  test("does not fall back after a configured backend starts a request", async () => {
    const requestedUrls: string[] = [];
    const output = await executeWebSearch(
      { query: "current news" },
      {
        config: defaultWebSearchConfig,
        credentials: {},
        env: {
          BRAVE_SEARCH_API_KEY: "brave-key",
          TAVILY_API_KEY: "tavily-key",
        },
        fetch: async (input) => {
          requestedUrls.push(String(input));
          return new Response("unavailable", { status: 503 });
        },
      },
    );

    expect(output.error?.code).toBe("http_error");
    expect(output.provider).toBe("brave");
    expect(requestedUrls).toHaveLength(1);
  });

  test("propagates caller cancellation into search fetch", async () => {
    const controller = new AbortController();
    const pending = executeWebSearch(
      { query: "current news" },
      {
        config: { ...defaultWebSearchConfig, backend: "tavily" },
        credentials: {},
        env: { TAVILY_API_KEY: "tavily-key" },
        signal: controller.signal,
        fetch: async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      },
    );

    controller.abort();
    const output = await pending;
    expect(output.ok).toBe(false);
    expect(output.error?.code).toBe("aborted");
  });

  test("returns a distinct timeout error", async () => {
    const output = await executeWebSearch(
      { query: "current news" },
      {
        config: {
          ...defaultWebSearchConfig,
          backend: "brave",
          timeoutMs: 1000,
        },
        credentials: {},
        env: { BRAVE_SEARCH_API_KEY: "brave-key" },
        fetch: async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      },
    );

    expect(output.ok).toBe(false);
    expect(output.error?.code).toBe("timeout");
  });

  test("enforces the configured local use limit per turn", async () => {
    clearWebSearchTurnUses();
    let requests = 0;
    const options = {
      config: {
        ...defaultWebSearchConfig,
        backend: "brave" as const,
        maxUsesPerTurn: 1,
      },
      credentials: {},
      env: { BRAVE_SEARCH_API_KEY: "brave-key" },
      turnKey: "session:turn",
      fetch: async () => {
        requests += 1;
        return Response.json({ web: { results: [] } });
      },
    };

    expect((await executeWebSearch({ query: "one" }, options)).ok).toBe(true);
    const limited = await executeWebSearch({ query: "two" }, options);
    expect(limited.error?.code).toBe("max_uses_exceeded");
    expect(requests).toBe(1);
  });
});
