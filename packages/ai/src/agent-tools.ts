import { z } from "zod";
import {
  ANTHROPIC_TOOL_OPTIONAL_PARAMETER_BUDGET,
  MAX_TOOL_LIST_ENTRIES,
  MAX_TOOL_SEARCH_RESULTS,
  MAX_TOOL_TEXT_OUTPUT_CHARS,
} from "./constants";
import {
  codingAgentModes,
  codingAgentModeSchema,
  codingAgentToolNameSchema,
  defaultCodingAgentMode,
  type CodingAgentMode,
} from "./coding-agent-modes";
import {
  permissionModeSchema,
  permissionRulesSchema,
  PermissionPolicy,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRules,
} from "./permissions";
import {
  sandboxConfigSchema,
  type SandboxConfig,
} from "./sandbox/config";
import { classifyBashCommand } from "./bash/command-classification";
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
  readFileDescription,
  readFileInputSchema,
  readFileOutputSchema,
  readFileProviderInputSchema,
} from "./read-file/schema";
import {
  writeFileDescription,
  writeFileInputSchema,
  writeFileOutputSchema,
  writeFileProviderInputSchema,
} from "./write-file/schema";
import {
  requestUserInputDescription,
  requestUserInputToolInputSchema,
  requestUserInputToolOutputSchema,
  requestUserInputToolProviderInputSchema,
} from "./request-user-input/schema";
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
  skillDescription,
  skillInputSchema,
  skillOutputSchema,
  skillProviderInputSchema,
} from "./skills/schema";
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

export {
  ANTHROPIC_TOOL_OPTIONAL_PARAMETER_BUDGET,
  MAX_TOOL_LIST_ENTRIES,
  MAX_TOOL_SEARCH_RESULTS,
  MAX_TOOL_TEXT_OUTPUT_CHARS,
};

export const codingChatRequestSchema = z.object({
  messages: z.array(z.json()),
  cwd: z.string().min(1).max(4096),
  mode: codingAgentModeSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  allowedTools: z.array(codingAgentToolNameSchema).optional(),
  permissionRules: permissionRulesSchema.optional(),
  sandbox: sandboxConfigSchema.optional(),
});

export const codingToolDescriptions = {
  list_files: listFilesDescription,
  glob_search: globSearchDescription,
  read_file: readFileDescription,
  grep: grepDescription,
  git_status: gitStatusDescription,
  git_diff: gitDiffDescription,
  git_log: gitLogDescription,
  git_show: gitShowDescription,
  tool_search: toolSearchDescription,
  skill: skillDescription,
  list_mcp_resources: listMcpResourcesDescription,
  read_mcp_resource: readMcpResourceDescription,
  call_mcp_tool: callMcpToolDescription,
  request_user_input: requestUserInputDescription,
  todo_write: todoWriteDescription,
  write_file: writeFileDescription,
  edit_file: editFileDescription,
  bash: bashDescription,
  web_fetch: webFetchDescription,
  web_search: webSearchDescription,
} as const;

export const codingToolInputSchemas = {
  list_files: listFilesInputSchema,
  glob_search: globSearchInputSchema,
  read_file: readFileInputSchema,
  grep: grepInputSchema,
  git_status: gitStatusInputSchema,
  git_diff: gitDiffInputSchema,
  git_log: gitLogInputSchema,
  git_show: gitShowInputSchema,
  tool_search: toolSearchInputSchema,
  skill: skillInputSchema,
  list_mcp_resources: listMcpResourcesInputSchema,
  read_mcp_resource: readMcpResourceInputSchema,
  call_mcp_tool: callMcpToolInputSchema,
  request_user_input: requestUserInputToolInputSchema,
  todo_write: todoWriteInputSchema,
  write_file: writeFileInputSchema,
  edit_file: editFileInputSchema,
  bash: bashInputSchema,
  web_fetch: webFetchInputSchema,
  web_search: webSearchInputSchema,
} as const;

export const codingToolProviderInputSchemas = {
  list_files: listFilesProviderInputSchema,
  glob_search: globSearchProviderInputSchema,
  read_file: readFileProviderInputSchema,
  grep: grepProviderInputSchema,
  git_status: gitStatusProviderInputSchema,
  git_diff: gitDiffProviderInputSchema,
  git_log: gitLogProviderInputSchema,
  git_show: gitShowProviderInputSchema,
  tool_search: toolSearchProviderInputSchema,
  skill: skillProviderInputSchema,
  list_mcp_resources: listMcpResourcesProviderInputSchema,
  read_mcp_resource: readMcpResourceProviderInputSchema,
  call_mcp_tool: callMcpToolProviderInputSchema,
  request_user_input: requestUserInputToolProviderInputSchema,
  todo_write: todoWriteProviderInputSchema,
  write_file: writeFileProviderInputSchema,
  edit_file: editFileProviderInputSchema,
  bash: bashProviderInputSchema,
  web_fetch: webFetchProviderInputSchema,
  web_search: webSearchProviderInputSchema,
} as const;

export const codingToolOutputSchemas = {
  list_files: listFilesOutputSchema,
  glob_search: globSearchOutputSchema,
  read_file: readFileOutputSchema,
  grep: grepOutputSchema,
  git_status: gitStatusOutputSchema,
  git_diff: gitDiffOutputSchema,
  git_log: gitLogOutputSchema,
  git_show: gitShowOutputSchema,
  tool_search: toolSearchOutputSchema,
  skill: skillOutputSchema,
  list_mcp_resources: listMcpResourcesOutputSchema,
  read_mcp_resource: readMcpResourceOutputSchema,
  call_mcp_tool: callMcpToolOutputSchema,
  request_user_input: requestUserInputToolOutputSchema,
  todo_write: todoWriteOutputSchema,
  write_file: writeFileOutputSchema,
  edit_file: editFileOutputSchema,
  bash: bashOutputSchema,
  web_fetch: webFetchOutputSchema,
  web_search: webSearchOutputSchema,
} as const;

export type CodingToolName = keyof typeof codingToolInputSchemas;

export type CodingToolInputByName = {
  [K in CodingToolName]: z.infer<(typeof codingToolInputSchemas)[K]>;
};

export type CodingToolOutputByName = {
  [K in CodingToolName]: z.infer<(typeof codingToolOutputSchemas)[K]>;
};

export const codingToolPermissionRequirements = {
  list_files: "read-only",
  glob_search: "read-only",
  read_file: "read-only",
  grep: "read-only",
  git_status: "read-only",
  git_diff: "read-only",
  git_log: "read-only",
  git_show: "read-only",
  tool_search: "read-only",
  skill: "read-only",
  list_mcp_resources: "read-only",
  read_mcp_resource: "read-only",
  call_mcp_tool: "danger-full-access",
  request_user_input: "read-only",
  todo_write: "workspace-write",
  write_file: "workspace-write",
  edit_file: "workspace-write",
  bash: "danger-full-access",
  web_fetch: "danger-full-access",
  web_search: "danger-full-access",
} satisfies Record<CodingToolName, PermissionMode>;

export const codingAgentCallOptionsSchema = z.object({
  cwd: z.string().min(1).max(4096),
  mode: codingAgentModeSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  allowedTools: z.array(codingAgentToolNameSchema).optional(),
  permissionRules: permissionRulesSchema.optional(),
  sandbox: sandboxConfigSchema.optional(),
});

export type CodingAgentCallOptions = z.infer<typeof codingAgentCallOptionsSchema>;

export function defaultPermissionModeForCodingMode(
  mode: CodingAgentMode,
): PermissionMode {
  return mode === "plan" ? "read-only" : "workspace-write";
}

export function resolveCodingPermissionMode({
  mode,
  permissionMode,
}: {
  mode: CodingAgentMode;
  permissionMode?: PermissionMode;
}): PermissionMode {
  if (mode === "plan") {
    return "read-only";
  }

  return permissionMode ?? defaultPermissionModeForCodingMode(mode);
}

export function createCodingPermissionPolicy({
  mode,
  permissionMode,
  allowedTools,
  permissionRules,
  approved,
  toolRequirements = codingToolPermissionRequirements,
}: {
  mode: CodingAgentMode;
  permissionMode?: PermissionMode;
  allowedTools?: readonly CodingToolName[];
  permissionRules?: PermissionRules;
  approved?: boolean;
  toolRequirements?: Readonly<Record<CodingToolName, PermissionMode>>;
}) {
  return new PermissionPolicy({
    activeMode: resolveCodingPermissionMode({ mode, permissionMode }),
    toolRequirements,
    allowedTools,
    rules: permissionRules,
    approved,
  });
}

function getStringInputProperty(input: unknown, key: string): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const value = Reflect.get(input, key);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function getCodingToolPermissionRequirement(
  toolName: CodingToolName,
  input: unknown,
): { permissionMode: PermissionMode; reason?: string } {
  if (toolName !== "bash") {
    return {
      permissionMode: codingToolPermissionRequirements[toolName],
    };
  }

  const command = getStringInputProperty(input, "command") ?? "";
  const classification = classifyBashCommand(command);

  return {
    permissionMode: classification.permissionMode,
    reason: classification.reason,
  };
}

export function evaluateCodingToolPermission({
  toolName,
  input,
  mode,
  permissionMode,
  allowedTools,
  permissionRules,
  approved,
}: {
  toolName: CodingToolName;
  input: unknown;
  mode: CodingAgentMode;
  permissionMode?: PermissionMode;
  allowedTools?: readonly CodingToolName[];
  permissionRules?: PermissionRules;
  approved?: boolean;
}): PermissionDecision {
  const requirement = getCodingToolPermissionRequirement(toolName, input);
  const toolRequirements = {
    ...codingToolPermissionRequirements,
    [toolName]: requirement.permissionMode,
  };
  const decision = createCodingPermissionPolicy({
    mode,
    permissionMode,
    allowedTools,
    permissionRules,
    approved,
    toolRequirements,
  }).decide(toolName, input);

  if (toolName === "bash" && requirement.reason) {
    return {
      ...decision,
      reason:
        decision.reason && decision.reason !== requirement.reason
          ? `${decision.reason} ${requirement.reason}`
          : requirement.reason,
    };
  }

  return decision;
}

export function normalizeSandboxConfig(
  sandbox: SandboxConfig | undefined,
): SandboxConfig | undefined {
  return sandbox ? sandboxConfigSchema.parse(sandbox) : undefined;
}

export function getActiveCodingToolsForPolicy({
  modeTools,
  mode,
  permissionMode,
  allowedTools,
  permissionRules,
}: {
  modeTools: readonly CodingToolName[];
  mode: CodingAgentMode;
  permissionMode?: PermissionMode;
  allowedTools?: readonly CodingToolName[];
  permissionRules?: PermissionRules;
}): CodingToolName[] {
  return modeTools.filter((toolName) => {
    const decision = evaluateCodingToolPermission({
      toolName,
      input: {},
      mode,
      permissionMode,
      allowedTools,
      permissionRules,
    });

    return decision.outcome !== "deny";
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function countOptionalPropertiesInJsonSchema(jsonSchema: unknown): number {
  if (!isRecord(jsonSchema)) {
    return 0;
  }

  const typeValue = Reflect.get(jsonSchema, "type");
  const properties = Reflect.get(jsonSchema, "properties");
  const required = new Set(getStringArray(Reflect.get(jsonSchema, "required")));
  let count = 0;

  if (typeValue === "object" && isRecord(properties)) {
    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      if (!required.has(propertyName)) {
        count += 1;
      }

      count += countOptionalPropertiesInJsonSchema(propertySchema);
    }
  }

  const items = Reflect.get(jsonSchema, "items");
  if (items) {
    count += countOptionalPropertiesInJsonSchema(items);
  }

  for (const compositeKey of ["anyOf", "oneOf", "allOf"] as const) {
    const compositeSchemas = Reflect.get(jsonSchema, compositeKey);
    if (Array.isArray(compositeSchemas)) {
      count += compositeSchemas.reduce(
        (total, schema) => total + countOptionalPropertiesInJsonSchema(schema),
        0,
      );
    }
  }

  return count;
}

function getJsonSchemaType(jsonSchema: unknown): string | undefined {
  if (typeof jsonSchema !== "object" || jsonSchema === null) {
    return undefined;
  }

  const typeValue = Reflect.get(jsonSchema, "type");
  return typeof typeValue === "string" ? typeValue : undefined;
}

export function collectToolSchemaPreflight() {
  const entries = Object.entries(codingToolProviderInputSchemas).map(([toolName, schema]) => {
    if (!(schema instanceof z.ZodObject)) {
      throw new Error(`Tool "${toolName}" provider-facing schema must be a top-level object.`);
    }

    const jsonSchema = z.toJSONSchema(schema, {
      target: "draft-7",
      io: "input",
    });

    const optionalPropertyCount = countOptionalPropertiesInJsonSchema(jsonSchema);

    return {
      toolName,
      inputSchemaType: getJsonSchemaType(jsonSchema),
      optionalPropertyCount,
    };
  });

  return entries;
}

export function assertProviderToolSchemaBudget(
  maxOptionalProperties = ANTHROPIC_TOOL_OPTIONAL_PARAMETER_BUDGET
) {
  const preflightEntries = collectToolSchemaPreflight();
  const entryByToolName = new Map(
    preflightEntries.map((entry) => [entry.toolName, entry]),
  );

  for (const entry of preflightEntries) {
    if (entry.inputSchemaType !== "object") {
      throw new Error(
        `Tool "${entry.toolName}" provider-facing input schema must compile to JSON schema type "object".`
      );
    }

    if (entry.optionalPropertyCount > maxOptionalProperties) {
      throw new Error(
        `Tool "${entry.toolName}" has ${entry.optionalPropertyCount} optional top-level properties (max ${maxOptionalProperties}).`
      );
    }
  }

  for (const [mode, definition] of Object.entries(codingAgentModes)) {
    const optionalPropertyCount = definition.activeTools.reduce((count, toolName) => {
      return count + (entryByToolName.get(toolName)?.optionalPropertyCount ?? 0);
    }, 0);

    if (optionalPropertyCount > maxOptionalProperties) {
      throw new Error(
        `Mode "${mode}" active tool schemas have ${optionalPropertyCount} optional properties total (max ${maxOptionalProperties}).`
      );
    }
  }
}
