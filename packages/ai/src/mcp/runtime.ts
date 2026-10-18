import { loadLightcodeConfig } from "../config/lightcode-config";
import { McpServerManager } from "./manager";
import {
  callMcpToolInputSchema,
  callMcpToolOutputSchema,
  listMcpResourcesInputSchema,
  listMcpResourcesOutputSchema,
  listMcpToolsInputSchema,
  listMcpToolsOutputSchema,
  readMcpResourceInputSchema,
  readMcpResourceOutputSchema,
} from "./schema";

interface McpRuntimeOptions {
  cwd?: string;
  abortSignal?: AbortSignal;
}

const noServersMessage =
  "No MCP servers are configured. Add them under mcp.servers in ~/.lightcode/settings.json (or the project's .lightcode/settings.json), " +
  'e.g. {"mcp":{"servers":{"docs":{"command":"npx","args":["-y","some-mcp-server"]}}}} or {"type":"http","url":"https://…"}.';

/** A manager over the user + project config for `cwd`; connections are shared. */
export function createMcpManager(cwd?: string) {
  const config = loadLightcodeConfig({ cwd }).config.mcp;
  return new McpServerManager(config, { cwd });
}

/** Enabled MCP servers for a workspace, for the agent's environment block. */
export function listEnabledMcpServerNames(cwd?: string): string[] {
  return createMcpManager(cwd).enabledServerNames();
}

export async function executeListMcpTools(input: unknown, { cwd, abortSignal }: McpRuntimeOptions = {}) {
  const parsedInput = listMcpToolsInputSchema.parse(input);
  const manager = createMcpManager(cwd);
  if (manager.enabledServerNames().length === 0) {
    return listMcpToolsOutputSchema.parse({ servers: manager.listServers(), tools: [], message: noServersMessage });
  }
  const output = await manager.listTools({
    server: parsedInput.server,
    toolName: parsedInput.toolName,
    signal: abortSignal,
  });
  return listMcpToolsOutputSchema.parse(output);
}

export async function executeListMcpResources(input: unknown, { cwd, abortSignal }: McpRuntimeOptions = {}) {
  const parsedInput = listMcpResourcesInputSchema.parse(input);
  const manager = createMcpManager(cwd);
  if (manager.enabledServerNames().length === 0) {
    return listMcpResourcesOutputSchema.parse({ servers: manager.listServers(), resources: [], message: noServersMessage });
  }
  const output = await manager.listResources(parsedInput.server, { signal: abortSignal });
  return listMcpResourcesOutputSchema.parse(output);
}

export async function executeReadMcpResource(input: unknown, { cwd, abortSignal }: McpRuntimeOptions = {}) {
  const parsedInput = readMcpResourceInputSchema.parse(input);
  const output = await createMcpManager(cwd).readResource(parsedInput.server, parsedInput.uri, {
    signal: abortSignal,
  });
  return readMcpResourceOutputSchema.parse(output);
}

export async function executeCallMcpTool(input: unknown, { cwd, abortSignal }: McpRuntimeOptions = {}) {
  const parsedInput = callMcpToolInputSchema.parse(input);
  const output = await createMcpManager(cwd).callTool(
    parsedInput.server,
    parsedInput.toolName,
    parsedInput.arguments,
    { signal: abortSignal },
  );
  return callMcpToolOutputSchema.parse(output);
}
