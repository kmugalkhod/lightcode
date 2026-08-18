import { describe, expect, test } from "bun:test";
import { buildProviderSettingsUpdate } from "./provider-settings";

describe("buildProviderSettingsUpdate", () => {
  test("clears an old model and base URL when switching to Anthropic", () => {
    expect(
      buildProviderSettingsUpdate({
        provider: "anthropic",
        model: "deepseek/deepseek-chat",
        baseUrl: "https://old-endpoint.example.test/v1",
      }),
    ).toEqual({
      provider: "anthropic",
      model: undefined,
      baseUrl: undefined,
    });
  });

  test("keeps the requested model but clears a custom endpoint for hosted providers", () => {
    expect(
      buildProviderSettingsUpdate({
        provider: "openrouter",
        model: "deepseek/deepseek-chat",
        baseUrl: "https://old-endpoint.example.test/v1",
      }),
    ).toEqual({
      provider: "openrouter",
      model: "deepseek/deepseek-chat",
      baseUrl: undefined,
    });
  });

  test("keeps both model and endpoint for OpenAI-compatible providers", () => {
    expect(
      buildProviderSettingsUpdate({
        provider: "openai-compatible",
        model: "local-model",
        baseUrl: "https://models.example.test/v1",
      }),
    ).toEqual({
      provider: "openai-compatible",
      model: "local-model",
      baseUrl: "https://models.example.test/v1",
    });
  });
});
