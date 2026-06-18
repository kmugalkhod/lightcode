import { describe, expect, test } from "bun:test";
import {
  defaultAutoContinueConfig,
  defaultContextOptimizerConfig,
} from "@lightcode/ai";
import {
  createConfigStatus,
  resolveConfiguredProviderModel,
  resolveModelAlias,
} from "./provider-registry";

const baseConfig = {
  provider: "anthropic",
  defaultMode: "build",
  context: defaultContextOptimizerConfig,
  maxOutputTokens: 10000,
  maxSteps: 5,
  maxRetries: 5,
  autoContinue: defaultAutoContinueConfig,
} as const;

describe("provider registry", () => {
  test("resolves Anthropic model aliases", () => {
    expect(resolveModelAlias("anthropic", "haiku")).toBe("claude-haiku-4-5");
    expect(resolveModelAlias("anthropic", "sonnet")).toBe("claude-sonnet-4-6");
    expect(resolveModelAlias("anthropic", "opus")).toBe("claude-opus-4-7");
    expect(resolveModelAlias("anthropic", "claude-custom")).toBe("claude-custom");
    expect(resolveModelAlias("openai-compatible", "haiku")).toBe("haiku");
    expect(resolveModelAlias("opencode-zen", "minimax-m2.5-free")).toBe(
      "minimax-m2.5-free",
    );
    expect(resolveModelAlias("openrouter", "minimax/minimax-m2.7")).toBe(
      "minimax/minimax-m2.7",
    );
  });

  test("defaults Anthropic to haiku and reports missing credentials", () => {
    const resolved = resolveConfiguredProviderModel({
      config: baseConfig,
      env: {},
    });

    expect(resolved.provider).toBe("anthropic");
    expect(resolved.resolvedModelId).toBe("claude-haiku-4-5");
    expect(resolved.missingCredentialHints.length).toBe(1);
  });

  test("requires a model and base URL for OpenAI-compatible providers", () => {
    expect(() =>
      resolveConfiguredProviderModel({
        config: {
          ...baseConfig,
          provider: "openai-compatible",
        },
        env: {},
      }),
    ).toThrow(/model/);

    expect(() =>
      resolveConfiguredProviderModel({
        config: {
          ...baseConfig,
          provider: "openai-compatible",
          model: "local-model",
        },
        env: {},
      }),
    ).toThrow(/baseUrl/);
  });

  test("resolves OpenAI-compatible model details when configured", () => {
    const resolved = resolveConfiguredProviderModel({
      config: {
        ...baseConfig,
        provider: "openai-compatible",
        model: "local-model",
        baseUrl: "http://localhost:11434/v1",
      },
      env: {
        LIGHTCODE_OPENAI_COMPATIBLE_API_KEY: "test-key",
      },
    });

    expect(resolved.provider).toBe("openai-compatible");
    expect(resolved.configuredModel).toBe("local-model");
    expect(resolved.resolvedModelId).toBe("local-model");
    expect(resolved.baseUrl).toBe("http://localhost:11434/v1");
    expect(resolved.missingCredentialHints).toEqual([]);
  });

  test("resolves OpenCode Zen as a first-class provider", () => {
    const resolved = resolveConfiguredProviderModel({
      config: {
        ...baseConfig,
        provider: "opencode-zen",
        model: "minimax-m2.7",
      },
      env: {
        OPENCODE_API_KEY: "test-opencode-key",
      },
    });

    expect(resolved.provider).toBe("opencode-zen");
    expect(resolved.resolvedModelId).toBe("minimax-m2.7");
    expect(resolved.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(resolved.missingCredentialHints).toEqual([]);
  });

  test("allows OpenCode Zen base URL override", () => {
    const resolved = resolveConfiguredProviderModel({
      config: {
        ...baseConfig,
        provider: "opencode-zen",
        model: "minimax-m2.5-free",
      },
      env: {
        OPENCODE_ZEN_BASE_URL: "https://example.test/zen/v1",
        OPENCODE_API_KEY: "test-opencode-key",
      },
    });

    expect(resolved.provider).toBe("opencode-zen");
    expect(resolved.baseUrl).toBe("https://example.test/zen/v1");
  });

  test("resolves OpenRouter as a first-class provider", () => {
    const resolved = resolveConfiguredProviderModel({
      config: {
        ...baseConfig,
        provider: "openrouter",
        model: "minimax/minimax-m2.7",
      },
      env: {
        OPENROUTER_API_KEY: "test-openrouter-key",
      },
    });

    expect(resolved.provider).toBe("openrouter");
    expect(resolved.resolvedModelId).toBe("minimax/minimax-m2.7");
    expect(resolved.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(resolved.missingCredentialHints).toEqual([]);
  });

  test("allows OpenRouter base URL override", () => {
    const resolved = resolveConfiguredProviderModel({
      config: {
        ...baseConfig,
        provider: "openrouter",
        model: "minimax/minimax-m2.7",
      },
      env: {
        OPENROUTER_BASE_URL: "https://example.test/api/v1",
        OPENROUTER_API_KEY: "test-openrouter-key",
      },
    });

    expect(resolved.provider).toBe("openrouter");
    expect(resolved.baseUrl).toBe("https://example.test/api/v1");
  });

  test("routes through the headroom proxy when enabled, keeping the real baseUrl", () => {
    const resolved = resolveConfiguredProviderModel({
      config: {
        ...baseConfig,
        provider: "openrouter",
        model: "minimax/minimax-m2.7",
        headroom: {
          enabled: true,
          proxyUrl: "http://127.0.0.1:8787",
          providers: null,
          failOpen: true,
        },
      },
      env: {
        OPENROUTER_API_KEY: "test-openrouter-key",
      },
    });

    // Real upstream is preserved for diagnostics; the SDK is pointed at the proxy.
    expect(resolved.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(resolved.effectiveBaseUrl).toBe("http://127.0.0.1:8787");
    expect(resolved.headroomRouted).toBe(true);
  });

  test("does not route providers outside the headroom providers list", () => {
    const resolved = resolveConfiguredProviderModel({
      config: {
        ...baseConfig,
        provider: "anthropic",
        model: "sonnet",
        headroom: {
          enabled: true,
          proxyUrl: "http://127.0.0.1:8787",
          providers: ["openrouter"],
          failOpen: true,
        },
      },
      env: {
        ANTHROPIC_API_KEY: "test-key",
      },
    });

    expect(resolved.headroomRouted).toBe(false);
    expect(resolved.effectiveBaseUrl).toBe(resolved.baseUrl);
  });

  test("leaves routing off when headroom is disabled", () => {
    const resolved = resolveConfiguredProviderModel({
      config: {
        ...baseConfig,
        provider: "openrouter",
        model: "minimax/minimax-m2.7",
        headroom: {
          enabled: false,
          proxyUrl: "http://127.0.0.1:8787",
          providers: null,
          failOpen: true,
        },
      },
      env: {
        OPENROUTER_API_KEY: "test-openrouter-key",
      },
    });

    expect(resolved.headroomRouted).toBe(false);
    expect(resolved.effectiveBaseUrl).toBe("https://openrouter.ai/api/v1");
  });

  test("reports headroom status in the config status payload", () => {
    const config = {
      ...baseConfig,
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
      headroom: {
        enabled: true,
        proxyUrl: "http://127.0.0.1:8787",
        providers: null,
        failOpen: true,
      },
    } as const;
    const resolved = resolveConfiguredProviderModel({
      config,
      env: { OPENROUTER_API_KEY: "test-openrouter-key" },
    });
    const status = createConfigStatus({
      config,
      loadedFiles: [],
      resolvedProviderModel: resolved,
    });

    expect(status.headroom.enabled).toBe(true);
    expect(status.headroom.proxyUrl).toBe("http://127.0.0.1:8787");
    expect(status.headroom.routed).toBe(true);
  });

  test("builds config status from resolved provider details", () => {
    const resolved = resolveConfiguredProviderModel({
      config: {
        ...baseConfig,
        model: "sonnet",
      },
      env: {
        ANTHROPIC_API_KEY: "test-key",
      },
    });
    const status = createConfigStatus({
      config: {
        ...baseConfig,
        model: "sonnet",
      },
      loadedFiles: [],
      resolvedProviderModel: resolved,
    });

    expect(status.selectedProvider).toBe("anthropic");
    expect(status.configuredModel).toBe("sonnet");
    expect(status.selectedModel).toBe("claude-sonnet-4-6");
    expect(status.missingCredentialHints).toEqual([]);
  });
});
