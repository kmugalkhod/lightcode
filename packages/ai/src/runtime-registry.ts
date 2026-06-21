import {
  codingToolInputSchemas,
  codingToolOutputSchemas,
  evaluateCodingToolPermission,
  type CodingToolInputByName,
  type CodingToolName,
  type CodingToolOutputByName,
} from "./agent-tools";
import type { CodingAgentMode } from "./coding-agent-modes";
import { coerceToolInputToSchema } from "./common/coerce-tool-input";
import { assertNotRepeatingToolCall } from "./tool-call-repeat-guard";
import { executeBash } from "./bash/runtime";
import { executeEditFile } from "./edit-file/runtime";
import { executeGrep } from "./grep/runtime";
import { executeGlobSearch } from "./glob-search/runtime";
import {
  executeGitDiff,
  executeGitLog,
  executeGitShow,
  executeGitStatus,
} from "./git/runtime";
import { executeListFiles } from "./list-files/runtime";
import { executeReadFile } from "./read-file/runtime";
import { executeTodoWrite } from "./todo-write/runtime";
import { executeToolSearch } from "./tool-search/runtime";
import { loadSkill } from "./skills/runtime";
import {
  executeCallMcpTool,
  executeListMcpResources,
  executeReadMcpResource,
} from "./mcp/runtime";
import { executeWebFetch } from "./web-fetch/runtime";
import { executeWebSearch } from "./web-search/runtime";
import { executeWriteFile } from "./write-file/runtime";
import {
  PermissionDeniedError,
  type PermissionMode,
  type PermissionRules,
} from "./permissions";
import {
  createWorkspaceContext,
  type WorkspaceContext,
} from "./common/resolve-within-workspace";
import {
  getSandboxRuntimeStatus,
  type SandboxConfig,
} from "./sandbox/config";

export interface CodingToolExecutionOptions {
  mode: CodingAgentMode;
  permissionMode: PermissionMode;
  allowedTools?: readonly CodingToolName[];
  permissionRules?: PermissionRules;
  approved?: boolean;
  cwd?: string;
  sessionId?: string;
  /** Identifies the user turn for checkpoint/undo grouping of file edits. */
  turnKey?: string;
  workspaceContext?: WorkspaceContext;
  sandbox?: SandboxConfig;
}

interface CodingToolRuntimeContext {
  workspaceContext: WorkspaceContext;
  options?: CodingToolExecutionOptions;
}

function getWorkspaceContext(options?: CodingToolExecutionOptions) {
  return options?.workspaceContext ?? createWorkspaceContext(options?.cwd);
}

function assertSandboxSupport(options?: CodingToolExecutionOptions) {
  const sandboxStatus = getSandboxRuntimeStatus(options?.sandbox);
  if (sandboxStatus.enabled && !sandboxStatus.supported) {
    throw new Error(
      sandboxStatus.unsupportedReason ??
        "Shell sandbox execution is not supported in this environment.",
    );
  }
}

function assertToolPermission(
  toolName: CodingToolName,
  input: CodingToolInputByName[CodingToolName],
  options?: CodingToolExecutionOptions,
) {
  if (!options) {
    return;
  }

  const decision = evaluateCodingToolPermission({
    toolName,
    input,
    mode: options.mode,
    permissionMode: options.permissionMode,
    allowedTools: options.allowedTools,
    permissionRules: options.permissionRules,
    approved: options.approved,
  });

  if (decision.outcome !== "allow") {
    throw new PermissionDeniedError(decision);
  }
}

/**
 * Per-tool execution table. Adding a tool means adding its schema to
 * agent-tools and one entry here — the compiler enforces completeness.
 */
const codingToolRuntimes: {
  [K in CodingToolName]: (
    input: CodingToolInputByName[K],
    context: CodingToolRuntimeContext,
  ) => Promise<unknown> | unknown;
} = {
  list_files: (input, { workspaceContext }) =>
    executeListFiles(input, workspaceContext),
  glob_search: (input, { workspaceContext }) =>
    executeGlobSearch(input, workspaceContext),
  read_file: (input, { workspaceContext }) =>
    executeReadFile(input, workspaceContext),
  grep: (input, { workspaceContext }) => executeGrep(input, workspaceContext),
  git_status: (input, { workspaceContext }) =>
    executeGitStatus(input, workspaceContext),
  git_diff: (input, { workspaceContext }) =>
    executeGitDiff(input, workspaceContext),
  git_log: (input, { workspaceContext }) =>
    executeGitLog(input, workspaceContext),
  git_show: (input, { workspaceContext }) =>
    executeGitShow(input, workspaceContext),
  tool_search: (input) => executeToolSearch(input),
  skill: (input, { options }) => loadSkill(input, { cwd: options?.cwd }),
  list_mcp_resources: (input, { options }) =>
    executeListMcpResources(input, options?.cwd),
  read_mcp_resource: (input, { options }) =>
    executeReadMcpResource(input, options?.cwd),
  call_mcp_tool: (input, { options }) => executeCallMcpTool(input, options?.cwd),
  request_user_input: () => {
    throw new Error(
      'Tool "request_user_input" requires interactive UI handling and cannot run in runtime-registry.',
    );
  },
  todo_write: (input, { workspaceContext, options }) =>
    executeTodoWrite(input, {
      sessionId: options?.sessionId,
      workspaceContext,
    }),
  write_file: (input, { workspaceContext, options }) =>
    executeWriteFile(input, workspaceContext, {
      sessionId: options?.sessionId,
      turnKey: options?.turnKey,
    }),
  edit_file: (input, { workspaceContext, options }) =>
    executeEditFile(input, workspaceContext, {
      sessionId: options?.sessionId,
      turnKey: options?.turnKey,
    }),
  bash: (input, { workspaceContext, options }) => {
    assertSandboxSupport(options);
    return executeBash(input, workspaceContext);
  },
  web_fetch: (input) => executeWebFetch(input),
  web_search: (input) => executeWebSearch(input),
};

export function parseCodingToolInput<K extends CodingToolName>(
  toolName: K,
  rawInput: unknown,
): CodingToolInputByName[K] {
  // The schema map is keyed by tool name; indexing erases the per-key
  // relation, so narrow the parsed union back to the requested tool.
  const schema = codingToolInputSchemas[toolName];
  const parsed = schema.safeParse(rawInput);
  if (parsed.success) {
    return parsed.data as CodingToolInputByName[K];
  }

  // Cheaper models get the argument shape right but the types wrong (a number
  // sent as "10", a boolean as "true"). Coerce against the schema before giving
  // up so the call succeeds instead of failing strict validation.
  const coerced = coerceToolInputToSchema(rawInput, schema);
  if (coerced !== null) {
    return coerced as CodingToolInputByName[K];
  }

  // Still invalid (e.g. a required field is genuinely missing) — surface the
  // original, descriptive validation error.
  return schema.parse(rawInput) as CodingToolInputByName[K];
}

export async function executeCodingTool<K extends CodingToolName>(
  toolName: K,
  input: CodingToolInputByName[K],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName[K]> {
  const workspaceContext = getWorkspaceContext(options);
  const validatedInput = parseCodingToolInput(toolName, input);
  assertToolPermission(toolName, validatedInput, options);
  // Break weak-model loops that re-run the same read-only tool unchanged.
  assertNotRepeatingToolCall(toolName, validatedInput, options?.turnKey);

  const runtime = codingToolRuntimes[toolName] as (
    input: CodingToolInputByName[K],
    context: CodingToolRuntimeContext,
  ) => Promise<unknown> | unknown;
  const rawOutput = await runtime(validatedInput, { workspaceContext, options });

  return codingToolOutputSchemas[toolName].parse(
    rawOutput,
  ) as CodingToolOutputByName[K];
}

export { isPermissionDeniedError } from "./permissions";
