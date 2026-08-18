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
  codingToolDescriptions,
  codingToolInputSchemas,
  codingToolOutputSchemas,
  codingToolPermissionRequirements,
  codingToolProviderInputSchemas,
  codingToolRegistry,
  type CodingToolName,
} from "./tool-registry";
import {
  providerWebSearchDecisionSchema,
  type ProviderWebSearchDecision,
} from "./web-search/config";

export {
  codingToolDescriptions,
  codingToolInputSchemas,
  codingToolOutputSchemas,
  codingToolPermissionRequirements,
  codingToolProviderInputSchemas,
  codingToolRegistry,
};
export type { CodingToolName };

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
  providerWebSearchDecision: providerWebSearchDecisionSchema.optional(),
  allowedTools: z.array(codingAgentToolNameSchema).optional(),
  permissionRules: permissionRulesSchema.optional(),
  sandbox: sandboxConfigSchema.optional(),
});

/**
 * Tools executed inside the server's agent loop (via a tool `execute`
 * function) instead of being streamed to the client for local execution. The
 * client must skip these in its onToolCall handler — their output arrives
 * in-stream from the server.
 */
const serverExecutedCodingToolNames: ReadonlySet<CodingToolName> = new Set(
  (Object.keys(codingToolRegistry) as CodingToolName[]).filter(
    (toolName) => codingToolRegistry[toolName].execution !== "client",
  ),
);

export function isServerExecutedCodingTool(toolName: CodingToolName): boolean {
  return serverExecutedCodingToolNames.has(toolName);
}

export type CodingToolInputByName = {
  [K in CodingToolName]: z.infer<(typeof codingToolInputSchemas)[K]>;
};

export type CodingToolOutputByName = {
  [K in CodingToolName]: z.infer<(typeof codingToolOutputSchemas)[K]>;
};

export const codingAgentCallOptionsSchema = z.object({
  cwd: z.string().min(1).max(4096),
  /** Parent chat session id, used to attribute spawned subagent tasks. */
  sessionId: z.string().min(1).max(200).optional(),
  mode: codingAgentModeSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  /** One-turn pre-approval/denial for provider-executed web search. */
  providerWebSearchDecision: providerWebSearchDecisionSchema.optional(),
  allowedTools: z.array(codingAgentToolNameSchema).optional(),
  permissionRules: permissionRulesSchema.optional(),
  sandbox: sandboxConfigSchema.optional(),
  /** Per-turn workspace/environment block appended to the system prompt. */
  environmentContext: z.string().optional(),
  /**
   * Per-request output ceiling. The agent-level maxOutputTokens is a static
   * per-model cap; some endpoints (OpenRouter minimax) serve a smaller total
   * window than the catalog advertises, so input + max_tokens must be clamped
   * per request against the learned window or the provider hard-rejects (400).
   */
  maxOutputTokens: z.number().int().min(1).optional(),
  /** Effective provider context window after learned endpoint clamping. */
  contextWindow: z.number().int().positive().optional(),
  /** Token-bounded complete-turn tail used by per-step request fitting. */
  preserveRecentTokens: z.number().int().nonnegative().optional(),
  /** Pre-optimization input estimate used for compaction-savings telemetry. */
  originalInputTokens: z.number().int().nonnegative().optional(),
  /**
   * Server-internal cancellation used while materializing the provider-only
   * request view between agent steps. It is never serialized by a client.
   */
  assemblyAbortSignal: z.custom<AbortSignal>().optional(),
  /**
   * Identifies the user turn (derived from the last user message id) so
   * server-executed file edits group into one checkpoint/undo unit and the
   * repeat-call guard is scoped per turn, including approval continuations.
   */
  turnKey: z.string().min(1).max(200).optional(),
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

export type ProviderWebSearchAccessAction =
  | "expose"
  | "omit"
  | "approval-required";

/**
 * Resolves provider-native search before the model request starts. Unlike a
 * local search function, a provider tool may already have searched (and billed)
 * by the time a tool-call part is returned, so `needsApproval` is too late.
 */
export function resolveProviderWebSearchAccess({
  mode,
  permissionMode,
  allowedTools,
  permissionRules,
  decision,
}: {
  mode: CodingAgentMode;
  permissionMode?: PermissionMode;
  allowedTools?: readonly CodingToolName[];
  permissionRules?: PermissionRules;
  decision?: ProviderWebSearchDecision;
}): {
  action: ProviderWebSearchAccessAction;
  permissionDecision: PermissionDecision;
} {
  const permissionDecision = evaluateCodingToolPermission({
    toolName: "web_search",
    input: {},
    mode,
    permissionMode,
    allowedTools,
    permissionRules,
  });

  if (permissionDecision.outcome === "deny" || decision === "denied") {
    return { action: "omit", permissionDecision };
  }

  if (permissionDecision.outcome === "ask" && decision !== "approved") {
    return { action: "approval-required", permissionDecision };
  }

  return { action: "expose", permissionDecision };
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
