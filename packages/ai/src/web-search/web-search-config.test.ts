import { describe, expect, test } from "bun:test";
import {
  defaultWebSearchConfig,
  resolveWebSearchApiKeys,
  resolveWebSearchCapability,
} from "./config";

describe("web search capability", () => {
  test("prefers provider-native search in auto mode", () => {
    expect(
      resolveWebSearchCapability({
        config: defaultWebSearchConfig,
        provider: "openrouter",
        env: {
          OPENROUTER_API_KEY: "openrouter-key",
          BRAVE_SEARCH_API_KEY: "brave-key",
          TAVILY_API_KEY: "tavily-key",
        },
      }),
    ).toEqual({
      available: true,
      backend: "openrouter",
      execution: "provider",
      limits: {
        maxResults: 3,
        maxTotalResults: 6,
        maxUsesPerTurn: 3,
        maxCharactersPerResult: 1200,
        timeoutMs: 20000,
      },
      reason: null,
    });
  });

  test("falls back from unavailable native search to Brave then Tavily", () => {
    const brave = resolveWebSearchCapability({
      config: defaultWebSearchConfig,
      provider: "openai-compatible",
      env: {
        BRAVE_SEARCH_API_KEY: "brave-key",
        TAVILY_API_KEY: "tavily-key",
      },
    });
    const tavily = resolveWebSearchCapability({
      config: defaultWebSearchConfig,
      provider: "openai-compatible",
      env: { TAVILY_API_KEY: "tavily-key" },
    });

    expect(brave).toMatchObject({
      available: true,
      backend: "brave",
      execution: "local",
    });
    expect(tavily).toMatchObject({
      available: true,
      backend: "tavily",
      execution: "local",
    });
  });

  test("never falls through from an explicitly selected backend", () => {
    const capability = resolveWebSearchCapability({
      config: { ...defaultWebSearchConfig, backend: "brave" },
      provider: "openrouter",
      env: {
        OPENROUTER_API_KEY: "openrouter-key",
        TAVILY_API_KEY: "tavily-key",
      },
    });

    expect(capability).toMatchObject({
      available: false,
      backend: "brave",
      execution: "none",
    });
    expect(capability.reason).toContain("BRAVE_SEARCH_API_KEY");
  });

  test("uses stored local credentials and preserves environment precedence", () => {
    expect(
      resolveWebSearchApiKeys({
        env: {
          BRAVE_SEARCH_API_KEY: "environment-brave",
        },
        storedCredentials: {
          braveSearchApiKey: "stored-brave",
          tavilyApiKey: "stored-tavily",
        },
      }),
    ).toEqual({
      brave: "environment-brave",
      tavily: "stored-tavily",
    });
  });

  test("reports disabled and unsupported-provider setup states", () => {
    expect(
      resolveWebSearchCapability({
        config: { ...defaultWebSearchConfig, backend: "disabled" },
        provider: "openrouter",
        env: { OPENROUTER_API_KEY: "key" },
      }),
    ).toMatchObject({
      available: false,
      backend: "disabled",
      execution: "none",
    });

    expect(
      resolveWebSearchCapability({
        config: { ...defaultWebSearchConfig, backend: "provider" },
        provider: "openai-compatible",
        env: {},
      }),
    ).toMatchObject({
      available: false,
      backend: "unavailable",
      execution: "none",
    });
  });
});
