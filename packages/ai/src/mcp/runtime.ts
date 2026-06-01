import { loadLightcodeConfig } from "../config/lightcode-config";
import { McpServerManager } from "./manager";
import {
  callMcpToolInputSchema,
  callMcpToolOutputSchema,
  listMcpResourcesInputSchema,
  listMcpResourcesOutputSchema,
  readMcpResourceInputSchema,
  readMcpResourceOutputSchema,
} from "./schema";

function createManager(cwd?: string) {
  const config = loadLightcodeConfig({ cwd }).config.mcp;
  return new McpServerManager(config);
}

export function executeListMcpResources(input: unknown, cwd?: string) {
  const parsedInput = listMcpResourcesInputSchema.parse(input);
  const output = createManager(cwd).listResources(parsedInput.server);
  return listMcpResourcesOutputSchema.parse(output);
}

export function executeReadMcpResource(input: unknown, cwd?: string) {
  const parsedInput = readMcpResourceInputSchema.parse(input);
  const output = createManager(cwd).readResource(
    parsedInput.server,
    parsedInput.uri,
  );
  return readMcpResourceOutputSchema.parse(output);
}

export function executeCallMcpTool(input: unknown, cwd?: string) {
  const parsedInput = callMcpToolInputSchema.parse(input);
  const output = createManager(cwd).callTool(
    parsedInput.server,
    parsedInput.toolName,
    parsedInput.arguments,
  );
  return callMcpToolOutputSchema.parse(output);
}
