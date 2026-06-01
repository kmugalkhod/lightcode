import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  pluginHookResultSchema,
  pluginManifestSchema,
  type PluginHookEvent,
  type PluginSummary,
} from "./schema";

function pluginRoots(cwd: string) {
  return [
    path.join(cwd, ".lightcode", "plugins"),
    path.join(os.homedir(), ".lightcode", "plugins"),
  ];
}

export function listPlugins({ cwd = process.cwd() }: { cwd?: string } = {}) {
  const plugins: PluginSummary[] = [];

  for (const root of pluginRoots(cwd)) {
    if (!existsSync(root)) {
      continue;
    }

    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const manifestPath = path.join(root, entry.name, "plugin.json");
      if (!existsSync(manifestPath)) {
        continue;
      }

      const manifest = pluginManifestSchema.parse(
        JSON.parse(readFileSync(manifestPath, "utf8")),
      );
      plugins.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version ?? null,
        description: manifest.description ?? null,
        enabled: manifest.enabled,
        path: manifestPath,
        hookCount: manifest.hooks.length,
      });
    }
  }

  return plugins.sort((left, right) => left.id.localeCompare(right.id));
}

export async function runPluginHooks({
  event,
  cwd = process.cwd(),
}: {
  event: PluginHookEvent;
  cwd?: string;
}) {
  const manifests = listPlugins({ cwd });

  if (Bun.env.LIGHTCODE_ENABLE_PLUGIN_HOOKS !== "true") {
    return {
      result: "allow" as const,
      hooksRun: 0,
      skipped: manifests.reduce((count, plugin) => count + plugin.hookCount, 0),
      reason: "Plugin hooks are disabled unless LIGHTCODE_ENABLE_PLUGIN_HOOKS=true.",
    };
  }

  let hooksRun = 0;
  for (const plugin of manifests) {
    if (!plugin.enabled) {
      continue;
    }

    const manifest = pluginManifestSchema.parse(
      JSON.parse(readFileSync(plugin.path, "utf8")),
    );
    for (const hook of manifest.hooks.filter((candidate) => candidate.event === event)) {
      hooksRun += 1;
      const child = Bun.spawn([hook.command, ...hook.args], {
        cwd: path.dirname(plugin.path),
        stdout: "pipe",
        stderr: "pipe",
      });
      const timeout = Bun.sleep(hook.timeoutMs).then(() => "timeout" as const);
      const finished = child.exited.then(() => "finished" as const);
      const status = await Promise.race([timeout, finished]);
      if (status === "timeout") {
        child.kill();
        return {
          result: "ask" as const,
          hooksRun,
          skipped: 0,
          reason: `Plugin hook timed out: ${plugin.id}`,
        };
      }

      const stdout = await new Response(child.stdout).text();
      const parsedResult = pluginHookResultSchema.safeParse(stdout.trim());
      if (parsedResult.success && parsedResult.data !== "allow") {
        return {
          result: parsedResult.data,
          hooksRun,
          skipped: 0,
          reason: `Plugin hook ${plugin.id} returned ${parsedResult.data}.`,
        };
      }
    }
  }

  return {
    result: "allow" as const,
    hooksRun,
    skipped: 0,
    reason: null,
  };
}
