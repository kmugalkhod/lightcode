import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { codingAgentModeSchema, defaultCodingAgentMode } from "../coding-agent-modes";
import { codingAgentToolNameSchema } from "../coding-agent-modes";
import {
  contextOptimizerConfigSchema,
  defaultContextOptimizerConfig,
  normalizeContextOptimizerConfig,
  resolvedContextOptimizerConfigSchema,
} from "../context";
import {
  permissionModeSchema,
  permissionRulesSchema,
} from "../permissions";
import { sandboxConfigSchema } from "../sandbox/config";
import { mcpConfigSchema } from "../mcp/config";

export const lightcodeProviderSchema = z.enum([
  "anthropic",
  "openai-compatible",
  "opencode-zen",
  "openrouter",
]);

export const autoContinueConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxAutoContinues: z.number().int().min(1).max(200).optional(),
    maxErrorRetries: z.number().int().min(1).max(10).optional(),
    /** Abort + retry a streaming response after this many silent seconds. */
    stallTimeoutSeconds: z.number().int().min(30).max(600).optional(),
  })
  .strict();
export type AutoContinueConfig = z.infer<typeof autoContinueConfigSchema>;

export const resolvedAutoContinueConfigSchema = z.object({
  enabled: z.boolean(),
  maxAutoContinues: z.number().int().min(1).max(200),
  maxErrorRetries: z.number().int().min(1).max(10),
  stallTimeoutSeconds: z.number().int().min(30).max(600),
});
export type ResolvedAutoContinueConfig = z.infer<
  typeof resolvedAutoContinueConfigSchema
>;

export const defaultAutoContinueConfig: ResolvedAutoContinueConfig = {
  enabled: true,
  maxAutoContinues: 50,
  maxErrorRetries: 5,
  // With 15s server heartbeats, 180s of byte silence means a dead connection
  // rather than a slow reasoning model.
  stallTimeoutSeconds: 180,
};

export const lightcodeConfigSchema = z
  .object({
    provider: lightcodeProviderSchema.optional(),
    model: z.string().min(1).max(240).optional(),
    baseUrl: z.string().min(1).max(4096).optional(),
    defaultMode: codingAgentModeSchema.optional(),
    permissionMode: permissionModeSchema.optional(),
    allowedTools: z.array(codingAgentToolNameSchema).optional(),
    permissions: permissionRulesSchema.optional(),
    sandbox: sandboxConfigSchema.optional(),
    mcp: mcpConfigSchema.optional(),
    context: contextOptimizerConfigSchema.optional(),
    maxOutputTokens: z.number().int().min(1).max(200_000).optional(),
    maxSteps: z.number().int().min(1).max(100).optional(),
    /** Provider-call retries for transient errors (429/5xx/network). */
    maxRetries: z.number().int().min(0).max(10).optional(),
    autoContinue: autoContinueConfigSchema.optional(),
  })
  .strict();

export type LightcodeProvider = z.infer<typeof lightcodeProviderSchema>;
export type LightcodeConfig = z.infer<typeof lightcodeConfigSchema>;

export const lightcodeConfigDefaults = {
  provider: "anthropic",
  defaultMode: defaultCodingAgentMode,
  context: defaultContextOptimizerConfig,
  // Reasoning tokens count against the output budget; thinking models need
  // far more than the text alone suggests.
  maxOutputTokens: 32_768,
  maxSteps: 30, // safety net only — the client-driven loop is budgeted by autoContinue
  // claw-code retries 8 times against the same status whitelist; 5 keeps
  // worst-case latency bounded while riding out provider blips.
  maxRetries: 5,
  autoContinue: defaultAutoContinueConfig,
} satisfies Pick<
  LightcodeResolvedConfig,
  | "provider"
  | "defaultMode"
  | "context"
  | "maxOutputTokens"
  | "maxSteps"
  | "maxRetries"
  | "autoContinue"
>;

export const loadedConfigFileSchema = z.object({
  scope: z.enum(["user", "project"]),
  path: z.string(),
  exists: z.boolean(),
  loaded: z.boolean(),
});
export type LoadedConfigFile = z.infer<typeof loadedConfigFileSchema>;

export const lightcodeResolvedConfigSchema = lightcodeConfigSchema.extend({
  provider: lightcodeProviderSchema,
  defaultMode: codingAgentModeSchema,
  context: resolvedContextOptimizerConfigSchema,
  maxOutputTokens: z.number().int().min(1).max(200_000),
  maxSteps: z.number().int().min(1).max(100),
  maxRetries: z.number().int().min(0).max(10),
  autoContinue: resolvedAutoContinueConfigSchema,
});
export type LightcodeResolvedConfig = z.infer<typeof lightcodeResolvedConfigSchema>;

export const lightcodeConfigLoadResultSchema = z.object({
  config: lightcodeResolvedConfigSchema,
  loadedFiles: z.array(loadedConfigFileSchema),
});
export type LightcodeConfigLoadResult = z.infer<
  typeof lightcodeConfigLoadResultSchema
>;

export const lightcodeConfigStatusSchema = z.object({
  loadedFiles: z.array(loadedConfigFileSchema),
  selectedProvider: lightcodeProviderSchema,
  configuredModel: z.string().nullable(),
  selectedModel: z.string(),
  baseUrl: z.string().nullable(),
  defaultMode: codingAgentModeSchema,
  permissionMode: permissionModeSchema.nullable(),
  maxOutputTokens: z.number().int().min(1).max(200_000),
  maxSteps: z.number().int().min(1).max(100),
  autoContinue: resolvedAutoContinueConfigSchema,
  /** Effective context window in tokens (config override or model metadata). */
  contextWindow: z.number().int().positive(),
  missingCredentialHints: z.array(z.string()),
});
export type LightcodeConfigStatus = z.infer<typeof lightcodeConfigStatusSchema>;

export class LightcodeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LightcodeConfigError";
  }
}

export interface LoadLightcodeConfigOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  projectConfigPath?: string;
  userConfigPath?: string;
}

function getDefaultUserConfigPath(env: Record<string, string | undefined>) {
  if (env.LIGHTCODE_USER_CONFIG) {
    return env.LIGHTCODE_USER_CONFIG;
  }

  return path.join(os.homedir(), ".lightcode", "settings.json");
}

function readConfigFile(
  scope: LoadedConfigFile["scope"],
  configPath: string,
): { config: LightcodeConfig; file: LoadedConfigFile } {
  if (!existsSync(configPath)) {
    return {
      config: {},
      file: {
        scope,
        path: configPath,
        exists: false,
        loaded: false,
      },
    };
  }

  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new LightcodeConfigError(
      `Unable to parse Lightcode config at ${configPath}: ${
        error instanceof Error ? error.message : "invalid JSON"
      }`,
    );
  }

  const parsedConfig = lightcodeConfigSchema.safeParse(rawConfig);
  if (!parsedConfig.success) {
    throw new LightcodeConfigError(
      `Invalid Lightcode config at ${configPath}: ${parsedConfig.error.message}`,
    );
  }

  return {
    config: parsedConfig.data,
    file: {
      scope,
      path: configPath,
      exists: true,
      loaded: true,
    },
  };
}

function parseNumberEnv(value: string | undefined, name: string) {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new LightcodeConfigError(`${name} must be a finite number.`);
  }

  return parsed;
}

function parseBooleanEnv(value: string | undefined, name: string) {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new LightcodeConfigError(`${name} must be a boolean value.`);
}

function readEnvBaseUrl(env: Record<string, string | undefined>) {
  if (env.LIGHTCODE_BASE_URL) {
    return env.LIGHTCODE_BASE_URL;
  }

  if (env.LIGHTCODE_PROVIDER === "opencode-zen") {
    return env.OPENCODE_ZEN_BASE_URL;
  }

  if (env.LIGHTCODE_PROVIDER === "openrouter") {
    return env.OPENROUTER_BASE_URL;
  }

  if (env.LIGHTCODE_PROVIDER === "openai-compatible") {
    return env.LIGHTCODE_OPENAI_COMPATIBLE_BASE_URL ?? env.OPENAI_BASE_URL;
  }

  if (env.LIGHTCODE_PROVIDER === "anthropic") {
    return env.ANTHROPIC_BASE_URL;
  }

  return (
    env.LIGHTCODE_OPENAI_COMPATIBLE_BASE_URL ??
    env.OPENCODE_ZEN_BASE_URL ??
    env.OPENROUTER_BASE_URL ??
    env.ANTHROPIC_BASE_URL
  );
}

function readEnvConfig(env: Record<string, string | undefined>): LightcodeConfig {
  const contextConfig = {
    autoCompact: parseBooleanEnv(
      env.LIGHTCODE_CONTEXT_AUTO_COMPACT,
      "LIGHTCODE_CONTEXT_AUTO_COMPACT",
    ),
    compactAtFraction: parseNumberEnv(
      env.LIGHTCODE_CONTEXT_COMPACT_AT_FRACTION,
      "LIGHTCODE_CONTEXT_COMPACT_AT_FRACTION",
    ),
    pruneAtFraction: parseNumberEnv(
      env.LIGHTCODE_CONTEXT_PRUNE_AT_FRACTION,
      "LIGHTCODE_CONTEXT_PRUNE_AT_FRACTION",
    ),
    contextWindowOverride: parseNumberEnv(
      env.LIGHTCODE_CONTEXT_WINDOW,
      "LIGHTCODE_CONTEXT_WINDOW",
    ),
    maxInputTokens: parseNumberEnv(
      env.LIGHTCODE_CONTEXT_MAX_INPUT_TOKENS,
      "LIGHTCODE_CONTEXT_MAX_INPUT_TOKENS",
    ),
    preserveRecentMessages: parseNumberEnv(
      env.LIGHTCODE_CONTEXT_PRESERVE_RECENT_MESSAGES,
      "LIGHTCODE_CONTEXT_PRESERVE_RECENT_MESSAGES",
    ),
    summaryMaxChars: parseNumberEnv(
      env.LIGHTCODE_CONTEXT_SUMMARY_MAX_CHARS,
      "LIGHTCODE_CONTEXT_SUMMARY_MAX_CHARS",
    ),
  };
  const compactContextConfig = Object.fromEntries(
    Object.entries(contextConfig).filter(([, value]) => value !== undefined),
  );
  const rawConfig = {
    provider: env.LIGHTCODE_PROVIDER,
    model: env.LIGHTCODE_CHAT_MODEL,
    baseUrl: readEnvBaseUrl(env),
    defaultMode: env.LIGHTCODE_DEFAULT_MODE,
    permissionMode: env.LIGHTCODE_PERMISSION_MODE,
    maxOutputTokens: parseNumberEnv(
      env.LIGHTCODE_MAX_OUTPUT_TOKENS,
      "LIGHTCODE_MAX_OUTPUT_TOKENS",
    ),
    maxSteps: parseNumberEnv(env.LIGHTCODE_MAX_STEPS, "LIGHTCODE_MAX_STEPS"),
    maxRetries: parseNumberEnv(env.LIGHTCODE_MAX_RETRIES, "LIGHTCODE_MAX_RETRIES"),
    context:
      Object.keys(compactContextConfig).length > 0
        ? compactContextConfig
        : undefined,
  };
  const compactConfig = Object.fromEntries(
    Object.entries(rawConfig).filter(([, value]) => value !== undefined),
  );
  const parsedConfig = lightcodeConfigSchema.safeParse(compactConfig);

  if (!parsedConfig.success) {
    throw new LightcodeConfigError(
      `Invalid Lightcode environment config: ${parsedConfig.error.message}`,
    );
  }

  return parsedConfig.data;
}

function mergeConfig(...configs: LightcodeConfig[]): LightcodeConfig {
  return configs.reduce<LightcodeConfig>(
    (mergedConfig, config) => ({
      ...mergedConfig,
      ...config,
      permissions: config.permissions ?? mergedConfig.permissions,
      sandbox: config.sandbox ?? mergedConfig.sandbox,
      mcp: config.mcp ?? mergedConfig.mcp,
      context: config.context
        ? {
            ...mergedConfig.context,
            ...config.context,
          }
        : mergedConfig.context,
      autoContinue: config.autoContinue
        ? {
            ...mergedConfig.autoContinue,
            ...config.autoContinue,
          }
        : mergedConfig.autoContinue,
      allowedTools: config.allowedTools ?? mergedConfig.allowedTools,
    }),
    {},
  );
}

export type UserSettingsUpdate = Partial<
  Pick<LightcodeConfig, "provider" | "model" | "baseUrl">
>;

/**
 * Merges a partial update into the user settings file
 * (~/.lightcode/settings.json by default), validating the result before
 * writing. Unknown keys already in the file are rejected by the schema the
 * same way loading rejects them — fail fast rather than persist garbage.
 */
export function updateUserSettings(
  update: UserSettingsUpdate,
  env: Record<string, string | undefined> = process.env,
): { path: string; config: LightcodeConfig } {
  const configPath = getDefaultUserConfigPath(env);
  const existing = readConfigFile("user", configPath).config;

  const merged: LightcodeConfig = { ...existing };
  for (const [key, value] of Object.entries(update)) {
    if (value === undefined || value === null) {
      delete merged[key as keyof UserSettingsUpdate];
    } else {
      Reflect.set(merged, key, value);
    }
  }

  const parsed = lightcodeConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new LightcodeConfigError(
      `Invalid settings update: ${parsed.error.message}`,
    );
  }

  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");

  return { path: configPath, config: parsed.data };
}

export function loadLightcodeConfig({
  cwd = process.cwd(),
  env = process.env,
  projectConfigPath = path.join(cwd, ".lightcode", "settings.json"),
  userConfigPath = getDefaultUserConfigPath(env),
}: LoadLightcodeConfigOptions = {}): LightcodeConfigLoadResult {
  const userConfig = readConfigFile("user", userConfigPath);
  const projectConfig = readConfigFile("project", projectConfigPath);
  const envConfig = readEnvConfig(env);
  const mergedConfig = mergeConfig(userConfig.config, projectConfig.config, envConfig);
  const config = {
    ...lightcodeConfigDefaults,
    ...mergedConfig,
    context: normalizeContextOptimizerConfig(mergedConfig.context),
    autoContinue: {
      ...defaultAutoContinueConfig,
      ...mergedConfig.autoContinue,
    },
  };

  return lightcodeConfigLoadResultSchema.parse({
    config,
    loadedFiles: [userConfig.file, projectConfig.file],
  });
}
