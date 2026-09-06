import { describe, expect, test } from "bun:test";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
} from "@ai-sdk/provider";
import {
  defaultAutoContinueConfig,
  defaultContextOptimizerConfig,
  defaultWebSearchConfig,
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
  webSearch: defaultWebSearchConfig,
  maxOutputTokens: 10000,
  maxSteps: 5,
  maxRetries: 5,
  autoContinue: defaultAutoContinueConfig,
} as const;

describe("provider registry", () => {
  test("an unauthenticated compatible model completes a real SDK tool round trip", async () => {
    const requests: Array<{ model: string; messages: Array<{ role: string; content?: unknown }> }> = [];
    let executions = 0;
    const resolved = resolveConfiguredProviderModel({
      config: { ...baseConfig, provider: "openai-compatible", model: "custom-model", baseUrl: "http://127.0.0.1:11434/v1" },
      env: {},
      fetch: async (_input, init) => {
        const request = z.object({ model: z.string(), messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() })) }).parse(JSON.parse(String(init?.body)));
        requests.push(request);
        const first = requests.length === 1;
        return Response.json({ id: `completion-${requests.length}`, created: 1, model: request.model, choices: [{ index: 0, finish_reason: first ? "tool_calls" : "stop", message: first ? { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "inspect", arguments: '{"path":"README.md"}' } }] } : { role: "assistant", content: "Reviewed README.md" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      },
    });
    const result = await generateText({
      model: resolved.model,
      prompt: "Inspect README.md",
      stopWhen: stepCountIs(3),
      tools: { inspect: tool({ inputSchema: z.object({ path: z.string() }), execute: async ({ path }) => { executions++; return { path, text: "Project documentation" }; } }) },
    });
    expect(executions).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.some((message) => message.role === "tool")).toBe(true);
    expect(result.text).toBe("Reviewed README.md");
  });
  test("permits unauthenticated OpenAI-compatible servers and arbitrary model IDs", () => {
    const resolved = resolveConfiguredProviderModel({ config: { ...baseConfig, provider: "openai-compatible", model: "local-custom-model", baseUrl: "http://127.0.0.1:11434/v1" }, env: {} });
    expect(resolved.missingCredentialHints).toEqual([]);
    expect(resolved.resolvedModelId).toBe("local-custom-model");
  });
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

  test("sets OpenRouter provider routing and attribution headers", () => {
    const resolved = resolveConfiguredProviderModel({
      config: {
        ...baseConfig,
        provider: "openrouter",
        model: "z-ai/glm-5.2",
      },
      env: {
        OPENROUTER_API_KEY: "test-openrouter-key",
      },
    });

    expect(resolved.provider).toBe("openrouter");
    // Routing lets OpenRouter fail over when one upstream drops a stream.
    expect(resolved.providerOptions).toEqual({
      openrouter: {
        provider: {
          allow_fallbacks: true,
          require_parameters: true,
        },
      },
    });
  });

  test("enables prompt caching for OpenRouter Anthropic-family models", () => {
    const resolved = resolveConfiguredProviderModel({
      config: {
        ...baseConfig,
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
      },
      env: { OPENROUTER_API_KEY: "test-openrouter-key" },
    });

    expect(resolved.supportsPromptCaching).toBe(true);
    // Top-level cache_control opts in to OpenRouter's automatic Anthropic
    // breakpoint placement; it is spread to the request body root.
    expect(resolved.providerOptions).toEqual({
      openrouter: {
        provider: {
          allow_fallbacks: true,
          require_parameters: true,
        },
        cache_control: { type: "ephemeral" },
      },
    });
  });

  test("does not opt non-Anthropic OpenRouter models into cache_control", () => {
    const resolved = resolveConfiguredProviderModel({
      config: {
        ...baseConfig,
        provider: "openrouter",
        model: "z-ai/glm-5.2",
      },
      env: { OPENROUTER_API_KEY: "test-openrouter-key" },
    });

    expect(resolved.supportsPromptCaching).toBe(false);
    expect(resolved.providerOptions).toEqual({
      openrouter: {
        provider: {
          allow_fallbacks: true,
          require_parameters: true,
        },
      },
    });
  });

  test("marks direct Anthropic as cache-capable", () => {
    const resolved = resolveConfiguredProviderModel({
      config: baseConfig,
      env: {},
    });

    expect(resolved.supportsPromptCaching).toBe(true);
  });

  test("does not set provider routing for non-OpenRouter OpenAI-compatible providers", () => {
    const resolved = resolveConfiguredProviderModel({
      config: {
        ...baseConfig,
        provider: "openai-compatible",
        model: "local-model",
        baseUrl: "http://localhost:11434/v1",
      },
      env: { LIGHTCODE_OPENAI_COMPATIBLE_API_KEY: "k" },
    });

    expect(resolved.providerOptions).toBeUndefined();
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
    expect(resolved.webSearchCapability).toMatchObject({
      available: true,
      backend: "openrouter",
      execution: "provider",
    });
    expect(resolved.providerTools?.web_search).toMatchObject({
      type: "provider",
      id: "openrouter.web_search",
      args: {
        parameters: {
          engine: "auto",
          max_results: 3,
          max_total_results: 6,
          max_uses: 3,
          max_characters: 1200,
        },
      },
    });
  });

  test("emits the bounded OpenRouter server-search wire contract", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const resolved = resolveConfiguredProviderModel({
      config: {
        ...baseConfig,
        provider: "openrouter",
        model: "deepseek/deepseek-chat",
      },
      env: {
        OPENROUTER_API_KEY: "test-openrouter-key",
        LIGHTCODE_CREDENTIALS: "/definitely/not/a/credential/file",
      },
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: "generation-1",
            model: "deepseek/deepseek-chat",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "done" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const tool = resolved.providerTools?.web_search as {
      id: `${string}.${string}`;
      args: Record<string, unknown>;
    };

    await (resolved.model as LanguageModelV3).doGenerate({
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "Search current DeepSeek news" }],
        },
      ],
      tools: [
        {
          type: "provider",
          id: tool.id,
          name: "web_search",
          args: tool.args,
        },
      ],
    } as LanguageModelV3CallOptions);

    expect(requestBody).not.toBeNull();
    expect((requestBody as unknown as Record<string, unknown>).tools).toEqual([
      {
        type: "openrouter:web_search",
        parameters: {
          engine: "auto",
          max_results: 3,
          max_total_results: 6,
          max_uses: 3,
          max_characters: 1200,
        },
      },
    ]);
  });

  test("selects the capability-gated Anthropic web-search version", () => {
    const legacy = resolveConfiguredProviderModel({
      config: { ...baseConfig, model: "haiku" },
      env: {
        ANTHROPIC_API_KEY: "test-key",
        LIGHTCODE_CREDENTIALS: "/definitely/not/a/credential/file",
      },
    });
    const dynamic = resolveConfiguredProviderModel({
      config: { ...baseConfig, model: "sonnet" },
      env: {
        ANTHROPIC_API_KEY: "test-key",
        LIGHTCODE_CREDENTIALS: "/definitely/not/a/credential/file",
      },
    });

    expect(legacy.providerTools?.web_search).toMatchObject({
      id: "anthropic.web_search_20250305",
      args: { maxUses: 3 },
    });
    expect(dynamic.providerTools?.web_search).toMatchObject({
      id: "anthropic.web_search_20260209",
      args: { maxUses: 3 },
    });
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
