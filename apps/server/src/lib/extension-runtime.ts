import {
  listPlugins,
  listSkills,
  McpServerManager,
} from "@lightcode/ai";
import { lightcodeConfigResult } from "./runtime-config";

export const mcpServerManager = new McpServerManager(
  lightcodeConfigResult.config.mcp,
);

export function getExtensionRuntimeStatus() {
  const skills = listSkills({ cwd: process.cwd() });
  const plugins = listPlugins({ cwd: process.cwd() });
  const mcpServers = mcpServerManager.listServers();

  return {
    skills: {
      count: skills.length,
    },
    mcp: {
      configuredServers: mcpServers.length,
      runningServers: mcpServers.filter((server) => server.state === "running").length,
      degradedServers: mcpServers.filter((server) => server.state === "degraded").length,
      servers: mcpServers,
    },
    plugins: {
      count: plugins.length,
      enabled: plugins.filter((plugin) => plugin.enabled).length,
      hooks: plugins.reduce((count, plugin) => count + plugin.hookCount, 0),
    },
  };
}
