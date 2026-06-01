import {
  codingToolInputSchemas,
  codingToolOutputSchemas,
  evaluateCodingToolPermission,
  type CodingToolInputByName,
  type CodingToolName,
  type CodingToolOutputByName,
} from "./agent-tools";
import type { CodingAgentMode } from "./coding-agent-modes";
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
  workspaceContext?: WorkspaceContext;
  sandbox?: SandboxConfig;
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

export function parseCodingToolInput(
  toolName: "list_files",
  rawInput: unknown,
): CodingToolInputByName["list_files"];
export function parseCodingToolInput(
  toolName: "glob_search",
  rawInput: unknown,
): CodingToolInputByName["glob_search"];
export function parseCodingToolInput(
  toolName: "read_file",
  rawInput: unknown,
): CodingToolInputByName["read_file"];
export function parseCodingToolInput(
  toolName: "grep",
  rawInput: unknown,
): CodingToolInputByName["grep"];
export function parseCodingToolInput(
  toolName: "git_status",
  rawInput: unknown,
): CodingToolInputByName["git_status"];
export function parseCodingToolInput(
  toolName: "git_diff",
  rawInput: unknown,
): CodingToolInputByName["git_diff"];
export function parseCodingToolInput(
  toolName: "git_log",
  rawInput: unknown,
): CodingToolInputByName["git_log"];
export function parseCodingToolInput(
  toolName: "git_show",
  rawInput: unknown,
): CodingToolInputByName["git_show"];
export function parseCodingToolInput(
  toolName: "tool_search",
  rawInput: unknown,
): CodingToolInputByName["tool_search"];
export function parseCodingToolInput(
  toolName: "skill",
  rawInput: unknown,
): CodingToolInputByName["skill"];
export function parseCodingToolInput(
  toolName: "list_mcp_resources",
  rawInput: unknown,
): CodingToolInputByName["list_mcp_resources"];
export function parseCodingToolInput(
  toolName: "read_mcp_resource",
  rawInput: unknown,
): CodingToolInputByName["read_mcp_resource"];
export function parseCodingToolInput(
  toolName: "call_mcp_tool",
  rawInput: unknown,
): CodingToolInputByName["call_mcp_tool"];
export function parseCodingToolInput(
  toolName: "request_user_input",
  rawInput: unknown,
): CodingToolInputByName["request_user_input"];
export function parseCodingToolInput(
  toolName: "todo_write",
  rawInput: unknown,
): CodingToolInputByName["todo_write"];
export function parseCodingToolInput(
  toolName: "write_file",
  rawInput: unknown,
): CodingToolInputByName["write_file"];
export function parseCodingToolInput(
  toolName: "edit_file",
  rawInput: unknown,
): CodingToolInputByName["edit_file"];
export function parseCodingToolInput(
  toolName: "bash",
  rawInput: unknown,
): CodingToolInputByName["bash"];
export function parseCodingToolInput(
  toolName: "web_fetch",
  rawInput: unknown,
): CodingToolInputByName["web_fetch"];
export function parseCodingToolInput(
  toolName: "web_search",
  rawInput: unknown,
): CodingToolInputByName["web_search"];
export function parseCodingToolInput(
  toolName: CodingToolName,
  rawInput: unknown,
): CodingToolInputByName[CodingToolName];
export function parseCodingToolInput(
  toolName: CodingToolName,
  rawInput: unknown,
): CodingToolInputByName[CodingToolName] {
  switch (toolName) {
    case "list_files":
      return codingToolInputSchemas.list_files.parse(rawInput);
    case "glob_search":
      return codingToolInputSchemas.glob_search.parse(rawInput);
    case "read_file":
      return codingToolInputSchemas.read_file.parse(rawInput);
    case "grep":
      return codingToolInputSchemas.grep.parse(rawInput);
    case "git_status":
      return codingToolInputSchemas.git_status.parse(rawInput);
    case "git_diff":
      return codingToolInputSchemas.git_diff.parse(rawInput);
    case "git_log":
      return codingToolInputSchemas.git_log.parse(rawInput);
    case "git_show":
      return codingToolInputSchemas.git_show.parse(rawInput);
    case "tool_search":
      return codingToolInputSchemas.tool_search.parse(rawInput);
    case "skill":
      return codingToolInputSchemas.skill.parse(rawInput);
    case "list_mcp_resources":
      return codingToolInputSchemas.list_mcp_resources.parse(rawInput);
    case "read_mcp_resource":
      return codingToolInputSchemas.read_mcp_resource.parse(rawInput);
    case "call_mcp_tool":
      return codingToolInputSchemas.call_mcp_tool.parse(rawInput);
    case "request_user_input":
      return codingToolInputSchemas.request_user_input.parse(rawInput);
    case "todo_write":
      return codingToolInputSchemas.todo_write.parse(rawInput);
    case "write_file":
      return codingToolInputSchemas.write_file.parse(rawInput);
    case "edit_file":
      return codingToolInputSchemas.edit_file.parse(rawInput);
    case "bash":
      return codingToolInputSchemas.bash.parse(rawInput);
    case "web_fetch":
      return codingToolInputSchemas.web_fetch.parse(rawInput);
    case "web_search":
      return codingToolInputSchemas.web_search.parse(rawInput);
  }
}

export function executeCodingTool(
  toolName: "list_files",
  input: CodingToolInputByName["list_files"],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName["list_files"]>;
export function executeCodingTool(
  toolName: "glob_search",
  input: CodingToolInputByName["glob_search"],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName["glob_search"]>;
export function executeCodingTool(
  toolName: "read_file",
  input: CodingToolInputByName["read_file"],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName["read_file"]>;
export function executeCodingTool(
  toolName: "grep",
  input: CodingToolInputByName["grep"],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName["grep"]>;
export function executeCodingTool(
  toolName: "git_status",
  input: CodingToolInputByName["git_status"],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName["git_status"]>;
export function executeCodingTool(
  toolName: "git_diff",
  input: CodingToolInputByName["git_diff"],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName["git_diff"]>;
export function executeCodingTool(
  toolName: "git_log",
  input: CodingToolInputByName["git_log"],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName["git_log"]>;
export function executeCodingTool(
  toolName: "git_show",
  input: CodingToolInputByName["git_show"],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName["git_show"]>;
export function executeCodingTool(
  toolName: "tool_search",
  input: CodingToolInputByName["tool_search"],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName["tool_search"]>;
export function executeCodingTool(
  toolName: "skill",
  input: CodingToolInputByName["skill"],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName["skill"]>;
export function executeCodingTool(
  toolName: "list_mcp_resources",
  input: CodingToolInputByName["list_mcp_resources"],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName["list_mcp_resources"]>;
export function executeCodingTool(
  toolName: "read_mcp_resource",
  input: CodingToolInputByName["read_mcp_resource"],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName["read_mcp_resource"]>;
export function executeCodingTool(
  toolName: "call_mcp_tool",
  input: CodingToolInputByName["call_mcp_tool"],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName["call_mcp_tool"]>;
export function executeCodingTool(
  toolName: "request_user_input",
  input: CodingToolInputByName["request_user_input"],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName["request_user_input"]>;
export function executeCodingTool(
  toolName: "todo_write",
  input: CodingToolInputByName["todo_write"],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName["todo_write"]>;
export function executeCodingTool(
  toolName: "write_file",
  input: CodingToolInputByName["write_file"],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName["write_file"]>;
export function executeCodingTool(
  toolName: "edit_file",
  input: CodingToolInputByName["edit_file"],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName["edit_file"]>;
export function executeCodingTool(
  toolName: "bash",
  input: CodingToolInputByName["bash"],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName["bash"]>;
export function executeCodingTool(
  toolName: "web_fetch",
  input: CodingToolInputByName["web_fetch"],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName["web_fetch"]>;
export function executeCodingTool(
  toolName: "web_search",
  input: CodingToolInputByName["web_search"],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName["web_search"]>;
export function executeCodingTool(
  toolName: CodingToolName,
  input: CodingToolInputByName[CodingToolName],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName[CodingToolName]>;
export async function executeCodingTool(
  toolName: CodingToolName,
  input: CodingToolInputByName[CodingToolName],
  options?: CodingToolExecutionOptions,
): Promise<CodingToolOutputByName[CodingToolName]> {
  const workspaceContext = getWorkspaceContext(options);

  switch (toolName) {
    case "list_files": {
      const validatedInput = codingToolInputSchemas.list_files.parse(input);
      assertToolPermission(toolName, validatedInput, options);
      const rawOutput = await executeListFiles(validatedInput, workspaceContext);
      return codingToolOutputSchemas.list_files.parse(rawOutput);
    }
    case "glob_search": {
      const validatedInput = codingToolInputSchemas.glob_search.parse(input);
      assertToolPermission(toolName, validatedInput, options);
      const rawOutput = await executeGlobSearch(validatedInput, workspaceContext);
      return codingToolOutputSchemas.glob_search.parse(rawOutput);
    }
    case "read_file": {
      const validatedInput = codingToolInputSchemas.read_file.parse(input);
      assertToolPermission(toolName, validatedInput, options);
      const rawOutput = await executeReadFile(validatedInput, workspaceContext);
      return codingToolOutputSchemas.read_file.parse(rawOutput);
    }
    case "grep": {
      const validatedInput = codingToolInputSchemas.grep.parse(input);
      assertToolPermission(toolName, validatedInput, options);
      const rawOutput = await executeGrep(validatedInput, workspaceContext);
      return codingToolOutputSchemas.grep.parse(rawOutput);
    }
    case "git_status": {
      const validatedInput = codingToolInputSchemas.git_status.parse(input);
      assertToolPermission(toolName, validatedInput, options);
      const rawOutput = await executeGitStatus(validatedInput, workspaceContext);
      return codingToolOutputSchemas.git_status.parse(rawOutput);
    }
    case "git_diff": {
      const validatedInput = codingToolInputSchemas.git_diff.parse(input);
      assertToolPermission(toolName, validatedInput, options);
      const rawOutput = await executeGitDiff(validatedInput, workspaceContext);
      return codingToolOutputSchemas.git_diff.parse(rawOutput);
    }
    case "git_log": {
      const validatedInput = codingToolInputSchemas.git_log.parse(input);
      assertToolPermission(toolName, validatedInput, options);
      const rawOutput = await executeGitLog(validatedInput, workspaceContext);
      return codingToolOutputSchemas.git_log.parse(rawOutput);
    }
    case "git_show": {
      const validatedInput = codingToolInputSchemas.git_show.parse(input);
      assertToolPermission(toolName, validatedInput, options);
      const rawOutput = await executeGitShow(validatedInput, workspaceContext);
      return codingToolOutputSchemas.git_show.parse(rawOutput);
    }
    case "tool_search": {
      const validatedInput = codingToolInputSchemas.tool_search.parse(input);
      assertToolPermission(toolName, validatedInput, options);
      const rawOutput = await executeToolSearch(validatedInput);
      return codingToolOutputSchemas.tool_search.parse(rawOutput);
    }
    case "skill": {
      const validatedInput = codingToolInputSchemas.skill.parse(input);
      assertToolPermission(toolName, validatedInput, options);
      const rawOutput = loadSkill(validatedInput, {
        cwd: options?.cwd,
      });
      return codingToolOutputSchemas.skill.parse(rawOutput);
    }
    case "list_mcp_resources": {
      const validatedInput = codingToolInputSchemas.list_mcp_resources.parse(input);
      assertToolPermission(toolName, validatedInput, options);
      const rawOutput = executeListMcpResources(validatedInput, options?.cwd);
      return codingToolOutputSchemas.list_mcp_resources.parse(rawOutput);
    }
    case "read_mcp_resource": {
      const validatedInput = codingToolInputSchemas.read_mcp_resource.parse(input);
      assertToolPermission(toolName, validatedInput, options);
      const rawOutput = executeReadMcpResource(validatedInput, options?.cwd);
      return codingToolOutputSchemas.read_mcp_resource.parse(rawOutput);
    }
    case "call_mcp_tool": {
      const validatedInput = codingToolInputSchemas.call_mcp_tool.parse(input);
      assertToolPermission(toolName, validatedInput, options);
      const rawOutput = executeCallMcpTool(validatedInput, options?.cwd);
      return codingToolOutputSchemas.call_mcp_tool.parse(rawOutput);
    }
    case "request_user_input": {
      codingToolInputSchemas.request_user_input.parse(input);

      throw new Error(
        'Tool "request_user_input" requires interactive UI handling and cannot run in runtime-registry.',
      );
    }
    case "todo_write": {
      const validatedInput = codingToolInputSchemas.todo_write.parse(input);
      assertToolPermission(toolName, validatedInput, options);
      const rawOutput = await executeTodoWrite(validatedInput, {
        sessionId: options?.sessionId,
        workspaceContext,
      });
      return codingToolOutputSchemas.todo_write.parse(rawOutput);
    }
    case "write_file": {
      const validatedInput = codingToolInputSchemas.write_file.parse(input);
      assertToolPermission(toolName, validatedInput, options);
      const rawOutput = await executeWriteFile(validatedInput, workspaceContext);
      return codingToolOutputSchemas.write_file.parse(rawOutput);
    }
    case "edit_file": {
      const validatedInput = codingToolInputSchemas.edit_file.parse(input);
      assertToolPermission(toolName, validatedInput, options);
      const rawOutput = await executeEditFile(validatedInput, workspaceContext);
      return codingToolOutputSchemas.edit_file.parse(rawOutput);
    }
    case "bash": {
      const validatedInput = codingToolInputSchemas.bash.parse(input);
      assertToolPermission(toolName, validatedInput, options);
      assertSandboxSupport(options);
      const rawOutput = await executeBash(validatedInput, workspaceContext);
      return codingToolOutputSchemas.bash.parse(rawOutput);
    }
    case "web_fetch": {
      const validatedInput = codingToolInputSchemas.web_fetch.parse(input);
      assertToolPermission(toolName, validatedInput, options);
      const rawOutput = await executeWebFetch(validatedInput);
      return codingToolOutputSchemas.web_fetch.parse(rawOutput);
    }
    case "web_search": {
      const validatedInput = codingToolInputSchemas.web_search.parse(input);
      assertToolPermission(toolName, validatedInput, options);
      const rawOutput = await executeWebSearch(validatedInput);
      return codingToolOutputSchemas.web_search.parse(rawOutput);
    }
  }
}

export { isPermissionDeniedError } from "./permissions";
