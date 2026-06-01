import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { codingAgentModeSchema, defaultCodingAgentMode } from "../coding-agent-modes";
import { codingAgentToolNameSchema } from "../coding-agent-modes";
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
    maxOutputTokens: z.number().int().min(1).max(200_000).optional(),
    maxSteps: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export type LightcodeProvider = z.infer<typeof lightcodeProviderSchema>;
export type LightcodeConfig = z.infer<typeof lightcodeConfigSchema>;

export const lightcodeConfigDefaults = {
  provider: "anthropic",
  defaultMode: defaultCodingAgentMode,
  maxOutputTokens: 4_096,
  maxSteps: 5,
} satisfies Required<
  Pick<LightcodeConfig, "provider" | "defaultMode" | "maxOutputTokens" | "maxSteps">
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
  maxOutputTokens: z.number().int().min(1).max(200_000),
  maxSteps: z.number().int().min(1).max(20),
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
  maxSteps: z.number().int().min(1).max(20),
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
      allowedTools: config.allowedTools ?? mergedConfig.allowedTools,
    }),
    {},
  );
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
  const config = {
    ...lightcodeConfigDefaults,
    ...mergeConfig(userConfig.config, projectConfig.config, envConfig),
  };

  return lightcodeConfigLoadResultSchema.parse({
    config,
    loadedFiles: [userConfig.file, projectConfig.file],
  });
}
