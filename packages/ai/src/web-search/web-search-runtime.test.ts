import { describe, expect, test } from "bun:test";
import { executeCodingTool } from "../runtime-registry";

describe("web_search runtime", () => {
  test("returns a structured not-configured error when no provider is available", async () => {
    const previousProvider = process.env.LIGHTCODE_WEB_SEARCH_PROVIDER;
    const previousBraveKey = process.env.BRAVE_SEARCH_API_KEY;
    const previousTavilyKey = process.env.TAVILY_API_KEY;

    delete process.env.LIGHTCODE_WEB_SEARCH_PROVIDER;
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.TAVILY_API_KEY;

    try {
      const output = await executeCodingTool(
        "web_search",
        {
          query: "Lightcode CLI",
          provider: "auto",
          maxResults: 5,
        },
        {
          cwd: process.cwd(),
          mode: "build",
          permissionMode: "danger-full-access",
        },
      );

      expect(output.ok).toBe(false);
      expect(output.error?.code).toBe("not_configured");
      expect(output.results).toEqual([]);
    } finally {
      if (previousProvider === undefined) {
        delete process.env.LIGHTCODE_WEB_SEARCH_PROVIDER;
      } else {
        process.env.LIGHTCODE_WEB_SEARCH_PROVIDER = previousProvider;
      }

      if (previousBraveKey === undefined) {
        delete process.env.BRAVE_SEARCH_API_KEY;
      } else {
        process.env.BRAVE_SEARCH_API_KEY = previousBraveKey;
      }

      if (previousTavilyKey === undefined) {
        delete process.env.TAVILY_API_KEY;
      } else {
        process.env.TAVILY_API_KEY = previousTavilyKey;
      }
    }
  });
});
