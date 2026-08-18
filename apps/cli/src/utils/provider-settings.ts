import type {
  LightcodeProvider,
  UserSettingsUpdate,
} from "@lightcode/ai";

interface ProviderSettingsInput {
  provider: LightcodeProvider;
  model?: string;
  baseUrl?: string;
}

/**
 * Provider selection is stored in a shared top-level config shape. Explicitly
 * include undefined fields so updateUserSettings removes values belonging to
 * the previously selected provider instead of silently reusing them.
 */
export function buildProviderSettingsUpdate({
  provider,
  model,
  baseUrl,
}: ProviderSettingsInput): UserSettingsUpdate {
  return {
    provider,
    model: provider === "anthropic" ? undefined : model?.trim() || undefined,
    baseUrl:
      provider === "openai-compatible"
        ? baseUrl?.trim() || undefined
        : undefined,
  };
}
