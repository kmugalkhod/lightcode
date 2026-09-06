import type { z } from "zod";
import type {
  CodingAgentMode,
  CodingAgentToolName,
} from "./coding-agent-modes";
import type { PermissionMode } from "./permissions";
import {
  agentDescription,
  agentInputSchema,
  agentOutputSchema,
  agentProviderInputSchema,
} from "./agent/schema";
import {
  bashDescription,
  bashInputSchema,
  bashOutputSchema,
  bashProviderInputSchema,
} from "./bash/schema";
import {
  editFileDescription,
  editFileInputSchema,
  editFileOutputSchema,
  editFileProviderInputSchema,
} from "./edit-file/schema";
import {
  grepDescription,
  grepInputSchema,
  grepOutputSchema,
  grepProviderInputSchema,
} from "./grep/schema";
import {
  globSearchDescription,
  globSearchInputSchema,
  globSearchOutputSchema,
  globSearchProviderInputSchema,
} from "./glob-search/schema";
import {
  gitDiffDescription,
  gitDiffInputSchema,
  gitDiffOutputSchema,
  gitDiffProviderInputSchema,
  gitLogDescription,
  gitLogInputSchema,
  gitLogOutputSchema,
  gitLogProviderInputSchema,
  gitShowDescription,
  gitShowInputSchema,
  gitShowOutputSchema,
  gitShowProviderInputSchema,
  gitStatusDescription,
  gitStatusInputSchema,
  gitStatusOutputSchema,
  gitStatusProviderInputSchema,
} from "./git/schema";
import {
  listFilesDescription,
  listFilesInputSchema,
  listFilesOutputSchema,
  listFilesProviderInputSchema,
} from "./list-files/schema";
import {
  callMcpToolDescription,
  callMcpToolInputSchema,
  callMcpToolOutputSchema,
  callMcpToolProviderInputSchema,
  listMcpResourcesDescription,
  listMcpResourcesInputSchema,
  listMcpResourcesOutputSchema,
  listMcpResourcesProviderInputSchema,
  readMcpResourceDescription,
  readMcpResourceInputSchema,
  readMcpResourceOutputSchema,
  readMcpResourceProviderInputSchema,
} from "./mcp/schema";
import {
  readFileDescription,
  readFileInputSchema,
  readFileOutputSchema,
  readFileProviderInputSchema,
} from "./read-file/schema";
import {
  requestUserInputDescription,
  requestUserInputToolInputSchema,
  requestUserInputToolOutputSchema,
  requestUserInputToolProviderInputSchema,
} from "./request-user-input/schema";
import {
  skillDescription,
  skillInputSchema,
  skillOutputSchema,
  skillProviderInputSchema,
} from "./skills/schema";
import {
  todoWriteDescription,
  todoWriteInputSchema,
  todoWriteOutputSchema,
  todoWriteProviderInputSchema,
} from "./todo-write/schema";
import {
  toolSearchDescription,
  toolSearchInputSchema,
  toolSearchOutputSchema,
  toolSearchProviderInputSchema,
} from "./tool-search/schema";
import {
  webFetchDescription,
  webFetchInputSchema,
  webFetchOutputSchema,
  webFetchProviderInputSchema,
} from "./web-fetch/schema";
import {
  webSearchDescription,
  webSearchInputSchema,
  webSearchOutputSchema,
  webSearchProviderInputSchema,
} from "./web-search/schema";
import {
  writeFileDescription,
  writeFileInputSchema,
  writeFileOutputSchema,
  writeFileProviderInputSchema,
} from "./write-file/schema";

export type CodingToolAvailability =
  | "always"
  | "model"
  | "git-workspace"
  | "skills"
  | "mcp"
  | "web";
export type CodingToolExecution = "server" | "client" | "server-or-provider";
export type CodingToolActivation = "core" | "specialized";
export type CodingToolOutputPolicy = "inline" | "artifact-if-large";

export interface CodingToolRegistryEntry<
  ToolName extends CodingAgentToolName = CodingAgentToolName,
> {
  description: string;
  inputSchema: z.ZodType;
  providerInputSchema: z.ZodType;
  outputSchema: z.ZodType;
  modes: readonly CodingAgentMode[];
  permissionSubject: ToolName;
  permissionMode: PermissionMode;
  execution: CodingToolExecution;
  availability: CodingToolAvailability;
  activation: CodingToolActivation;
  outputPolicy: CodingToolOutputPolicy;
}

type CodingToolRegistryShape = {
  [ToolName in CodingAgentToolName]: CodingToolRegistryEntry<ToolName>;
};

const buildOnly = ["build"] as const;
const planOnly = ["plan"] as const;
const bothModes = ["build", "plan"] as const;

/**
 * Single source of truth for every provider-visible coding tool. Runtime,
 * permission, diagnostics, discovery, and schema maps are derived from this
 * registry so adding a tool cannot leave one of those surfaces stale.
 */
export const codingToolRegistry = {
  agent: {
    description: agentDescription,
    inputSchema: agentInputSchema,
    providerInputSchema: agentProviderInputSchema,
    outputSchema: agentOutputSchema,
    modes: bothModes,
    permissionSubject: "agent",
    permissionMode: "read-only",
    execution: "server",
    availability: "model",
    activation: "core",
    outputPolicy: "artifact-if-large",
  },
  list_files: {
    description: listFilesDescription,
    inputSchema: listFilesInputSchema,
    providerInputSchema: listFilesProviderInputSchema,
    outputSchema: listFilesOutputSchema,
    modes: bothModes,
    permissionSubject: "list_files",
    permissionMode: "read-only",
    execution: "server",
    availability: "always",
    activation: "core",
    outputPolicy: "artifact-if-large",
  },
  glob_search: {
    description: globSearchDescription,
    inputSchema: globSearchInputSchema,
    providerInputSchema: globSearchProviderInputSchema,
    outputSchema: globSearchOutputSchema,
    modes: bothModes,
    permissionSubject: "glob_search",
    permissionMode: "read-only",
    execution: "server",
    availability: "always",
    activation: "core",
    outputPolicy: "artifact-if-large",
  },
  read_file: {
    description: readFileDescription,
    inputSchema: readFileInputSchema,
    providerInputSchema: readFileProviderInputSchema,
    outputSchema: readFileOutputSchema,
    modes: bothModes,
    permissionSubject: "read_file",
    permissionMode: "read-only",
    execution: "server",
    availability: "always",
    activation: "core",
    outputPolicy: "artifact-if-large",
  },
  grep: {
    description: grepDescription,
    inputSchema: grepInputSchema,
    providerInputSchema: grepProviderInputSchema,
    outputSchema: grepOutputSchema,
    modes: bothModes,
    permissionSubject: "grep",
    permissionMode: "read-only",
    execution: "server",
    availability: "always",
    activation: "core",
    outputPolicy: "artifact-if-large",
  },
  git_status: {
    description: gitStatusDescription,
    inputSchema: gitStatusInputSchema,
    providerInputSchema: gitStatusProviderInputSchema,
    outputSchema: gitStatusOutputSchema,
    modes: bothModes,
    permissionSubject: "git_status",
    permissionMode: "read-only",
    execution: "server",
    availability: "git-workspace",
    activation: "specialized",
    outputPolicy: "artifact-if-large",
  },
  git_diff: {
    description: gitDiffDescription,
    inputSchema: gitDiffInputSchema,
    providerInputSchema: gitDiffProviderInputSchema,
    outputSchema: gitDiffOutputSchema,
    modes: bothModes,
    permissionSubject: "git_diff",
    permissionMode: "read-only",
    execution: "server",
    availability: "git-workspace",
    activation: "specialized",
    outputPolicy: "artifact-if-large",
  },
  git_log: {
    description: gitLogDescription,
    inputSchema: gitLogInputSchema,
    providerInputSchema: gitLogProviderInputSchema,
    outputSchema: gitLogOutputSchema,
    modes: bothModes,
    permissionSubject: "git_log",
    permissionMode: "read-only",
    execution: "server",
    availability: "git-workspace",
    activation: "specialized",
    outputPolicy: "artifact-if-large",
  },
  git_show: {
    description: gitShowDescription,
    inputSchema: gitShowInputSchema,
    providerInputSchema: gitShowProviderInputSchema,
    outputSchema: gitShowOutputSchema,
    modes: bothModes,
    permissionSubject: "git_show",
    permissionMode: "read-only",
    execution: "server",
    availability: "git-workspace",
    activation: "specialized",
    outputPolicy: "artifact-if-large",
  },
  tool_search: {
    description: toolSearchDescription,
    inputSchema: toolSearchInputSchema,
    providerInputSchema: toolSearchProviderInputSchema,
    outputSchema: toolSearchOutputSchema,
    modes: bothModes,
    permissionSubject: "tool_search",
    permissionMode: "read-only",
    execution: "server",
    availability: "always",
    activation: "core",
    outputPolicy: "inline",
  },
  skill: {
    description: skillDescription,
    inputSchema: skillInputSchema,
    providerInputSchema: skillProviderInputSchema,
    outputSchema: skillOutputSchema,
    modes: bothModes,
    permissionSubject: "skill",
    permissionMode: "read-only",
    execution: "server",
    availability: "skills",
    activation: "core",
    outputPolicy: "artifact-if-large",
  },
  list_mcp_resources: {
    description: listMcpResourcesDescription,
    inputSchema: listMcpResourcesInputSchema,
    providerInputSchema: listMcpResourcesProviderInputSchema,
    outputSchema: listMcpResourcesOutputSchema,
    modes: bothModes,
    permissionSubject: "list_mcp_resources",
    permissionMode: "read-only",
    execution: "server",
    availability: "mcp",
    activation: "specialized",
    outputPolicy: "artifact-if-large",
  },
  read_mcp_resource: {
    description: readMcpResourceDescription,
    inputSchema: readMcpResourceInputSchema,
    providerInputSchema: readMcpResourceProviderInputSchema,
    outputSchema: readMcpResourceOutputSchema,
    modes: bothModes,
    permissionSubject: "read_mcp_resource",
    permissionMode: "read-only",
    execution: "server",
    availability: "mcp",
    activation: "specialized",
    outputPolicy: "artifact-if-large",
  },
  call_mcp_tool: {
    description: callMcpToolDescription,
    inputSchema: callMcpToolInputSchema,
    providerInputSchema: callMcpToolProviderInputSchema,
    outputSchema: callMcpToolOutputSchema,
    modes: buildOnly,
    permissionSubject: "call_mcp_tool",
    permissionMode: "danger-full-access",
    execution: "server",
    availability: "mcp",
    activation: "specialized",
    outputPolicy: "artifact-if-large",
  },
  request_user_input: {
    description: requestUserInputDescription,
    inputSchema: requestUserInputToolInputSchema,
    providerInputSchema: requestUserInputToolProviderInputSchema,
    outputSchema: requestUserInputToolOutputSchema,
    modes: planOnly,
    permissionSubject: "request_user_input",
    permissionMode: "read-only",
    execution: "client",
    availability: "always",
    activation: "core",
    outputPolicy: "inline",
  },
  todo_write: {
    description: todoWriteDescription,
    inputSchema: todoWriteInputSchema,
    providerInputSchema: todoWriteProviderInputSchema,
    outputSchema: todoWriteOutputSchema,
    modes: buildOnly,
    permissionSubject: "todo_write",
    permissionMode: "workspace-write",
    execution: "server",
    availability: "always",
    activation: "core",
    outputPolicy: "inline",
  },
  write_file: {
    description: writeFileDescription,
    inputSchema: writeFileInputSchema,
    providerInputSchema: writeFileProviderInputSchema,
    outputSchema: writeFileOutputSchema,
    modes: buildOnly,
    permissionSubject: "write_file",
    permissionMode: "workspace-write",
    execution: "server",
    availability: "always",
    activation: "core",
    outputPolicy: "inline",
  },
  edit_file: {
    description: editFileDescription,
    inputSchema: editFileInputSchema,
    providerInputSchema: editFileProviderInputSchema,
    outputSchema: editFileOutputSchema,
    modes: buildOnly,
    permissionSubject: "edit_file",
    permissionMode: "workspace-write",
    execution: "server",
    availability: "always",
    activation: "core",
    outputPolicy: "inline",
  },
  bash: {
    description: bashDescription,
    inputSchema: bashInputSchema,
    providerInputSchema: bashProviderInputSchema,
    outputSchema: bashOutputSchema,
    modes: buildOnly,
    permissionSubject: "bash",
    permissionMode: "danger-full-access",
    execution: "server",
    availability: "always",
    activation: "core",
    outputPolicy: "artifact-if-large",
  },
  web_fetch: {
    description: webFetchDescription,
    inputSchema: webFetchInputSchema,
    providerInputSchema: webFetchProviderInputSchema,
    outputSchema: webFetchOutputSchema,
    modes: buildOnly,
    permissionSubject: "web_fetch",
    permissionMode: "danger-full-access",
    execution: "server",
    availability: "web",
    activation: "specialized",
    outputPolicy: "artifact-if-large",
  },
  web_search: {
    description: webSearchDescription,
    inputSchema: webSearchInputSchema,
    providerInputSchema: webSearchProviderInputSchema,
    outputSchema: webSearchOutputSchema,
    modes: bothModes,
    permissionSubject: "web_search",
    permissionMode: "danger-full-access",
    execution: "server-or-provider",
    availability: "web",
    activation: "specialized",
    outputPolicy: "artifact-if-large",
  },
} as const satisfies CodingToolRegistryShape;

export type CodingToolName = keyof typeof codingToolRegistry;

function selectRegistryField<K extends keyof CodingToolRegistryEntry>(field: K) {
  return Object.fromEntries(
    Object.entries(codingToolRegistry).map(([name, entry]) => [
      name,
      entry[field],
    ]),
  ) as {
    [N in CodingToolName]: (typeof codingToolRegistry)[N][K];
  };
}

export const codingToolDescriptions = selectRegistryField("description");
export const codingToolInputSchemas = selectRegistryField("inputSchema");
export const codingToolProviderInputSchemas = selectRegistryField(
  "providerInputSchema",
);
export const codingToolOutputSchemas = selectRegistryField("outputSchema");
export const codingToolPermissionRequirements = selectRegistryField(
  "permissionMode",
);

export function getCodingToolRegistryEntry(toolName: CodingToolName) {
  return codingToolRegistry[toolName];
}

export function getRegistryToolsForMode(mode: CodingAgentMode): CodingToolName[] {
  return (Object.keys(codingToolRegistry) as CodingToolName[]).filter((name) =>
    (codingToolRegistry[name].modes as readonly CodingAgentMode[]).includes(mode),
  );
}
