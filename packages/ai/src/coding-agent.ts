import {
  type InferAgentUIMessage,
  type LanguageModel,
  type ToolSet,
  stepCountIs,
  ToolLoopAgent,
  tool,
} from "ai";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import type { z } from "zod";
import { createLogger } from "@lightcode/shared";
import {
  type CodingAgentCallOptions,
  type CodingToolName,
  codingAgentCallOptionsSchema,
  codingToolDescriptions,
  codingToolProviderInputSchemas,
  defaultPermissionModeForCodingMode,
  evaluateCodingToolPermission,
  getActiveCodingToolsForPolicy,
} from "./agent-tools";
import type { AgentToolInput, AgentToolOutput } from "./agent/schema";
import { buildCodingAgentSystemPrompt } from "./coding-agent-prompt";
import { repairCodingAgentToolCall } from "./coding-agent-tool-repair";
import {
  defaultCodingAgentMode,
  getCodingAgentModeDefinition,
} from "./coding-agent-modes";
import {
  limitProviderActiveTools,
  selectCodingAgentIntentTools,
} from "./intent-tool-selection";
import type { PermissionMode, PermissionRules } from "./permissions";
import {
  executeCodingTool,
  type CodingToolExecutionOptions,
} from "./runtime-registry";
import type { SandboxConfig } from "./sandbox/config";

const codingAgentLogger = createLogger("coding-agent");

/**
 * Per-call context forwarded to server-executed tools. Since the whole tool
 * loop runs server-side (pi-style, one request per user turn), this carries
 * everything the runtime needs: workspace, permission policy, and the turn
 * key that scopes checkpoints and the repeat-call guard.
 */
export interface CodingAgentExecutionContext {
  cwd: string;
  parentSessionId?: string;
  mode?: CodingAgentCallOptions["mode"];
  permissionMode?: PermissionMode;
  allowedTools?: readonly CodingToolName[];
  permissionRules?: PermissionRules;
  sandbox?: SandboxConfig;
  turnKey?: string;
}

/**
 * Server-side runner for the `agent` tool. Runs a subagent loop in a fresh
 * context and resolves with its capped final summary. Injected by the server
 * (which owns the model); without a runner the tool call fails cleanly.
 */
export type RunSubagentTool = (
  input: AgentToolInput,
  context: CodingAgentExecutionContext & { abortSignal?: AbortSignal },
) => Promise<AgentToolOutput>;

/** Tools that need the interactive client and never execute server-side. */
const clientInteractiveToolNames: ReadonlySet<CodingToolName> = new Set([
  "request_user_input",
]);

function toExecutionOptions(
  context: Partial<CodingAgentExecutionContext>,
): CodingToolExecutionOptions {
  const mode = context.mode ?? defaultCodingAgentMode;
  return {
    mode,
    permissionMode:
      context.permissionMode ?? defaultPermissionModeForCodingMode(mode),
    allowedTools: context.allowedTools,
    permissionRules: context.permissionRules,
    cwd: context.cwd,
    sessionId: context.parentSessionId,
    turnKey: context.turnKey,
    sandbox: context.sandbox,
  };
}

function readExecutionContext(
  experimental_context: unknown,
): Partial<CodingAgentExecutionContext> {
  return (experimental_context ?? {}) as Partial<CodingAgentExecutionContext>;
}

function decideToolPermission(
  toolName: CodingToolName,
  input: unknown,
  options: CodingToolExecutionOptions,
) {
  return evaluateCodingToolPermission({
    toolName,
    input,
    mode: options.mode,
    permissionMode: options.permissionMode,
    allowedTools: options.allowedTools,
    permissionRules: options.permissionRules,
  });
}

export function createCodingAgentTools(runSubagent?: RunSubagentTool): ToolSet {
  const tools: ToolSet = {};

  for (const name of Object.keys(codingToolDescriptions) as CodingToolName[]) {
    // `agent` executes inside the server loop with the injected runner: the
    // subagent needs the provider model, which only the server holds.
    if (name === "agent") {
      tools.agent = tool({
        description: codingToolDescriptions.agent,
        inputSchema: codingToolProviderInputSchemas.agent,
        strict: true,
        execute: async (input, { experimental_context, abortSignal }) => {
          if (!runSubagent) {
            throw new Error(
              "The agent tool requires a server-side subagent runner and is unavailable here.",
            );
          }

          const context = readExecutionContext(experimental_context);
          if (!context.cwd) {
            throw new Error(
              "The agent tool is missing its working directory context.",
            );
          }

          return runSubagent(input as AgentToolInput, {
            cwd: context.cwd,
            parentSessionId: context.parentSessionId,
            abortSignal,
          });
        },
      });
      continue;
    }

    // Interactive tools stream to the client without an execute function —
    // the loop pauses until the client posts the answer.
    if (clientInteractiveToolNames.has(name)) {
      tools[name] = tool({
        description: codingToolDescriptions[name],
        inputSchema: codingToolProviderInputSchemas[name] as z.ZodType<unknown>,
        strict: true,
      });
      continue;
    }

    // Everything else executes server-side inside the loop (pi-style): no
    // per-step HTTP round trip. Permission policy still gates every call —
    // "ask" defers to the SDK approval flow, "deny" throws (streams to the
    // client as output-error with the policy reason).
    tools[name] = tool({
      description: codingToolDescriptions[name],
      inputSchema: codingToolProviderInputSchemas[name] as z.ZodType<unknown>,
      strict: true,
      needsApproval: (input, { experimental_context }) => {
        const options = toExecutionOptions(
          readExecutionContext(experimental_context),
        );
        return decideToolPermission(name, input, options).outcome === "ask";
      },
      execute: async (input, { experimental_context }) => {
        const context = readExecutionContext(experimental_context);
        if (!context.cwd) {
          throw new Error(
            `The ${name} tool is missing its working directory context.`,
          );
        }

        const options = toExecutionOptions(context);
        // Reaching execute with an "ask" decision means the SDK already
        // collected the user's approval (needsApproval gated it); pass
        // approved so escalation rules resolve to allow. "deny" is re-checked
        // inside executeCodingTool and throws with the policy reason.
        const approved =
          decideToolPermission(name, input, options).outcome === "ask";

        return executeCodingTool(name, input as never, {
          ...options,
          approved,
        });
      },
    });
  }

  return tools;
}

export type CodingAgentTools = ReturnType<typeof createCodingAgentTools>;

export interface CreateCodingAgentOptions {
  model: LanguageModel;
  promptOverride?: string | null;
  maxOutputTokens?: number;
  maxSteps?: number;
  /** Provider-call retries for transient errors before surfacing them. */
  maxRetries?: number;
  providerOptions?: SharedV3ProviderOptions;
  /** Append tool-calling discipline for models prone to XML/text tool calls. */
  includeToolDiscipline?: boolean;
  /** Server-side runner backing the `agent` tool; omit to disable subagents. */
  runSubagent?: RunSubagentTool;
}

export function createCodingAgent({
  model,
  promptOverride,
  maxOutputTokens = 16384,
  maxSteps = 30,
  maxRetries = 5,
  providerOptions,
  includeToolDiscipline = false,
  runSubagent,
}: CreateCodingAgentOptions) {
  const tools = createCodingAgentTools(runSubagent);

  return new ToolLoopAgent<CodingAgentCallOptions, typeof tools>({
    model,
    tools,
    stopWhen: stepCountIs(maxSteps),
    maxOutputTokens,
    maxRetries,
    providerOptions,
    // Weak models misname tools or emit malformed argument JSON; repair
    // deterministically instead of failing the step.
    experimental_repairToolCall: repairCodingAgentToolCall,
    callOptionsSchema: codingAgentCallOptionsSchema,
    prepareCall: ({ options, prompt, messages, ...settings }) => {
      const mode = options.mode ?? defaultCodingAgentMode;
      const modeDefinition = getCodingAgentModeDefinition(mode);
      const intentTools = selectCodingAgentIntentTools({
        mode,
        prompt,
        messages,
      });
      const policyTools = getActiveCodingToolsForPolicy({
        modeTools: intentTools.filter((toolName) =>
          modeDefinition.activeTools.includes(toolName),
        ),
        mode,
        permissionMode: options.permissionMode,
        allowedTools: options.allowedTools,
        permissionRules: options.permissionRules,
      });
      const activeTools = limitProviderActiveTools(policyTools);

      codingAgentLogger.debug("coding_agent_active_tools", {
        mode,
        requestedTools: policyTools,
        activeTools,
        toolsDisabled: activeTools.length === 0,
      });

      return {
        ...settings,
        prompt,
        messages,
        // Per-request clamp beats the static per-model ceiling: the server
        // sizes it against what is actually left in the (learned) context
        // window after the input, so input + max_tokens can never overflow.
        ...(options.maxOutputTokens
          ? { maxOutputTokens: options.maxOutputTokens }
          : {}),
        tools: activeTools.length > 0 ? settings.tools : undefined,
        activeTools: activeTools.length > 0 ? activeTools : undefined,
        // Server-executed tools read the per-request context from here; the
        // interactive tools execute on the client and never see it.
        experimental_context: {
          cwd: options.cwd,
          parentSessionId: options.sessionId,
          mode,
          permissionMode: options.permissionMode,
          allowedTools: options.allowedTools,
          permissionRules: options.permissionRules,
          sandbox: options.sandbox,
          turnKey: options.turnKey,
        } satisfies CodingAgentExecutionContext,
        instructions: buildCodingAgentSystemPrompt({
          cwd: options.cwd,
          override: promptOverride,
          mode,
          includeToolDiscipline,
          environmentContext: options.environmentContext,
        }),
      };
    },
  });
}

export type CodingAgentUIMessage = InferAgentUIMessage<ReturnType<typeof createCodingAgent>>;
