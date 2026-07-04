import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LightcodeConfigError,
  loadLightcodeConfig,
} from "./lightcode-config";

const tempRoots: string[] = [];

async function makeTempDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "lightcode-config-"));
  tempRoots.push(directory);
  return directory;
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("loadLightcodeConfig", () => {
  test("loads user config, project config, and environment overrides", async () => {
    const cwd = await makeTempDirectory();
    const userConfigPath = path.join(cwd, "user-settings.json");
    const projectConfigPath = path.join(cwd, ".lightcode", "settings.json");

    await writeJson(userConfigPath, {
      provider: "anthropic",
      model: "haiku",
      defaultMode: "plan",
      context: {
        maxInputTokens: 50_000,
        preserveRecentMessages: 6,
      },
      maxOutputTokens: 1000,
    });
    await writeJson(projectConfigPath, {
      model: "sonnet",
      permissionMode: "workspace-write",
      context: {
        summaryMaxChars: 2_000,
      },
    });

    const result = loadLightcodeConfig({
      cwd,
      userConfigPath,
      env: {
        LIGHTCODE_CHAT_MODEL: "opus",
        LIGHTCODE_CONTEXT_PRESERVE_RECENT_MESSAGES: "8",
        LIGHTCODE_MAX_OUTPUT_TOKENS: "2000",
      },
    });

    expect(result.config.provider).toBe("anthropic");
    expect(result.config.model).toBe("opus");
    expect(result.config.defaultMode).toBe("plan");
    expect(result.config.permissionMode).toBe("workspace-write");
    // Legacy maxInputTokens maps to contextWindowOverride.
    expect(result.config.context.contextWindowOverride).toBe(50_000);
    expect(result.config.context.preserveRecentMessages).toBe(8);
    expect(result.config.context.summaryMaxChars).toBe(2_000);
    expect(result.config.maxOutputTokens).toBe(2000);
    expect(result.loadedFiles.every((file) => file.loaded)).toBe(true);
  });

  test("uses safe defaults when config files are absent", async () => {
    const cwd = await makeTempDirectory();
    const result = loadLightcodeConfig({
      cwd,
      userConfigPath: path.join(cwd, "missing-user.json"),
      env: {},
    });

    expect(result.config.provider).toBe("anthropic");
    expect(result.config.defaultMode).toBe("build");
    expect(result.config.context.autoCompact).toBe(true);
    expect(result.config.context.compactAtFraction).toBe(0.7);
    expect(result.config.context.pruneAtFraction).toBe(0.6);
    expect(result.config.context.contextWindowOverride).toBeNull();
    expect(result.config.context.preserveRecentMessages).toBe(6);
    expect(result.config.context.summaryMaxChars).toBe(4_000);
    expect(result.config.maxOutputTokens).toBe(32_768);
    expect(result.config.maxSteps).toBe(30);
    expect(result.config.autoContinue).toEqual({
      enabled: true,
      maxAutoContinues: 50,
      maxErrorRetries: 8,
      stallTimeoutSeconds: 300,
    });
    expect(result.loadedFiles.every((file) => !file.exists && !file.loaded)).toBe(
      true,
    );
  });

  test("merges partial autoContinue overrides onto defaults", async () => {
    const cwd = await makeTempDirectory();
    await writeJson(path.join(cwd, ".lightcode", "settings.json"), {
      autoContinue: { maxAutoContinues: 10 },
    });
    const result = loadLightcodeConfig({
      cwd,
      userConfigPath: path.join(cwd, "missing-user.json"),
      env: {},
    });

    expect(result.config.autoContinue).toEqual({
      enabled: true,
      maxAutoContinues: 10,
      maxErrorRetries: 8,
      stallTimeoutSeconds: 300,
    });
  });

  test("loads context optimizer settings from environment", async () => {
    const cwd = await makeTempDirectory();
    const result = loadLightcodeConfig({
      cwd,
      userConfigPath: path.join(cwd, "missing-user.json"),
      env: {
        LIGHTCODE_CONTEXT_AUTO_COMPACT: "false",
        LIGHTCODE_CONTEXT_MAX_INPUT_TOKENS: "12345",
        LIGHTCODE_CONTEXT_PRESERVE_RECENT_MESSAGES: "7",
        LIGHTCODE_CONTEXT_SUMMARY_MAX_CHARS: "1600",
      },
    });

    expect(result.config.context).toEqual({
      autoCompact: false,
      compactAtFraction: 0.7,
      pruneAtFraction: 0.6,
      contextWindowOverride: 12345,
      preserveRecentMessages: 7,
      maxCoverageTokensPerCompaction: 12_000,
      summaryMaxChars: 1600,
      aggressivePruneWhenUncached: true,
      uncachedPruneAtFraction: 0.45,
      uncachedPruneMinOutputChars: 600,
      uncachedQuantizeUserTurns: 1,
      uncachedRollingCompactionUserTurns: 10,
    });
  });

  test("loads tiered context thresholds and window from environment", async () => {
    const cwd = await makeTempDirectory();
    const result = loadLightcodeConfig({
      cwd,
      userConfigPath: path.join(cwd, "missing-user.json"),
      env: {
        LIGHTCODE_CONTEXT_COMPACT_AT_FRACTION: "0.7",
        LIGHTCODE_CONTEXT_PRUNE_AT_FRACTION: "0.5",
        LIGHTCODE_CONTEXT_WINDOW: "64000",
      },
    });

    expect(result.config.context.compactAtFraction).toBe(0.7);
    expect(result.config.context.pruneAtFraction).toBe(0.5);
    expect(result.config.context.contextWindowOverride).toBe(64_000);
  });

  test("loads OpenCode Zen provider and base URL from environment", async () => {
    const cwd = await makeTempDirectory();
    const result = loadLightcodeConfig({
      cwd,
      userConfigPath: path.join(cwd, "missing-user.json"),
      env: {
        LIGHTCODE_PROVIDER: "opencode-zen",
        LIGHTCODE_CHAT_MODEL: "minimax-m2.7",
        OPENCODE_ZEN_BASE_URL: "https://opencode.ai/zen/v1",
      },
    });

    expect(result.config.provider).toBe("opencode-zen");
    expect(result.config.model).toBe("minimax-m2.7");
    expect(result.config.baseUrl).toBe("https://opencode.ai/zen/v1");
  });

  test("does not mix Anthropic base URL into OpenCode Zen config", async () => {
    const cwd = await makeTempDirectory();
    const result = loadLightcodeConfig({
      cwd,
      userConfigPath: path.join(cwd, "missing-user.json"),
      env: {
        LIGHTCODE_PROVIDER: "opencode-zen",
        LIGHTCODE_CHAT_MODEL: "minimax-m2.5-free",
        ANTHROPIC_BASE_URL: "https://anthropic.example.test",
      },
    });

    expect(result.config.provider).toBe("opencode-zen");
    expect(result.config.baseUrl).toBeUndefined();
  });

  test("loads OpenRouter provider and base URL from environment", async () => {
    const cwd = await makeTempDirectory();
    const result = loadLightcodeConfig({
      cwd,
      userConfigPath: path.join(cwd, "missing-user.json"),
      env: {
        LIGHTCODE_PROVIDER: "openrouter",
        LIGHTCODE_CHAT_MODEL: "minimax/minimax-m2.7",
        OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
      },
    });

    expect(result.config.provider).toBe("openrouter");
    expect(result.config.model).toBe("minimax/minimax-m2.7");
    expect(result.config.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  test("does not mix OpenAI-compatible base URL into OpenRouter config", async () => {
    const cwd = await makeTempDirectory();
    const result = loadLightcodeConfig({
      cwd,
      userConfigPath: path.join(cwd, "missing-user.json"),
      env: {
        LIGHTCODE_PROVIDER: "openrouter",
        LIGHTCODE_CHAT_MODEL: "minimax/minimax-m2.7",
        OPENAI_BASE_URL: "https://openai-compatible.example.test",
      },
    });

    expect(result.config.provider).toBe("openrouter");
    expect(result.config.baseUrl).toBeUndefined();
  });

  test("throws a useful validation error for invalid config", async () => {
    const cwd = await makeTempDirectory();
    const projectConfigPath = path.join(cwd, ".lightcode", "settings.json");
    await writeJson(projectConfigPath, {
      provider: "unknown",
    });

    expect(() =>
      loadLightcodeConfig({
        cwd,
        projectConfigPath,
        userConfigPath: path.join(cwd, "missing-user.json"),
        env: {},
      }),
    ).toThrow(LightcodeConfigError);
  });
});
