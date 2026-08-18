import {
  type InferAgentUIMessage,
  type LanguageModel,
  type ModelMessage,
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
  resolveProviderWebSearchAccess,
} from "./agent-tools";
import type { AgentToolInput, AgentToolOutput } from "./agent/schema";
import { buildCodingAgentSystemPrompt } from "./coding-agent-prompt";
import { repairCodingAgentToolCall } from "./coding-agent-tool-repair";
import {
  defaultCodingAgentMode,
  getCodingAgentModeDefinition,
} from "./coding-agent-modes";
import {
  collectToolSearchDiscoveredTools,
  limitProviderActiveTools,
  selectCodingAgentIntentTools,
} from "./intent-tool-selection";
import type { PermissionMode, PermissionRules } from "./permissions";
import {
  executeCodingTool,
  type CodingToolExecutionOptions,
} from "./runtime-registry";
import type { SandboxConfig } from "./sandbox/config";
import { ProviderTurnAssembler } from "./context/provider-turn-assembler";
import { artifactizeLargeToolOutputs } from "./context/tool-output-artifacts";

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
  providerWebSearchDecision?: CodingAgentCallOptions["providerWebSearchDecision"];
  allowedTools?: readonly CodingToolName[];
  permissionRules?: PermissionRules;
  sandbox?: SandboxConfig;
  turnKey?: string;
  environmentContext?: string;
  activeTools?: CodingToolName[];
  contextWindow?: number;
  reservedOutputTokens?: number;
  preserveRecentTokens?: number;
  originalInputTokens?: number;
  assemblyAbortSignal?: AbortSignal;
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

export interface CodingAgentToolEvent {
  sessionId: string;
  kind: "tool_call_started" | "tool_call_result" | "tool_call_error";
  toolCallId: string;
  toolName: CodingToolName;
  input?: unknown;
  output?: unknown;
  error?: { name?: string; message: string };
}

/** Injected by the server so tool side effects are durably bracketed. */
export type RecordCodingAgentToolEvent = (
  event: CodingAgentToolEvent,
) => Promise<void>;

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

export function createCodingAgentTools(
  runSubagent?: RunSubagentTool,
  recordToolEvent?: RecordCodingAgentToolEvent,
): ToolSet {
  const tools: ToolSet = {};

  for (const name of Object.keys(codingToolDescriptions) as CodingToolName[]) {
    // `agent` executes inside the server loop with the injected runner: the
    // subagent needs the provider model, which only the server holds.
    if (name === "agent") {
      tools.agent = tool({
        description: codingToolDescriptions.agent,
        inputSchema: codingToolProviderInputSchemas.agent,
        strict: true,
        execute: async (
          input,
          { experimental_context, abortSignal, toolCallId },
        ) => {
          abortSignal?.throwIfAborted();
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

          if (context.parentSessionId && recordToolEvent) {
            await recordToolEvent({
              sessionId: context.parentSessionId,
              kind: "tool_call_started",
              toolCallId,
              toolName: "agent",
              input,
            });
          }
          try {
            abortSignal?.throwIfAborted();
            const output = await runSubagent(input as AgentToolInput, {
              cwd: context.cwd,
              parentSessionId: context.parentSessionId,
              abortSignal,
            });
            if (context.parentSessionId && recordToolEvent) {
              await recordToolEvent({
                sessionId: context.parentSessionId,
                kind: "tool_call_result",
                toolCallId,
                toolName: "agent",
                output,
              });
            }
            return output;
          } catch (error) {
            if (context.parentSessionId && recordToolEvent) {
              await recordToolEvent({
                sessionId: context.parentSessionId,
                kind: "tool_call_error",
                toolCallId,
                toolName: "agent",
                error: {
                  ...(error instanceof Error && error.name
                    ? { name: error.name }
                    : {}),
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              });
            }
            throw error;
          }
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
      needsApproval: (
        input: unknown,
        {
          experimental_context,
        }: {
          toolCallId: string;
          messages: ModelMessage[];
          experimental_context?: unknown;
        },
      ) => {
        const options = toExecutionOptions(
          readExecutionContext(experimental_context),
        );
        return decideToolPermission(name, input, options).outcome === "ask";
      },
      execute: async (
        input,
        { experimental_context, abortSignal, toolCallId },
      ) => {
        abortSignal?.throwIfAborted();
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

        if (context.parentSessionId && recordToolEvent) {
          await recordToolEvent({
            sessionId: context.parentSessionId,
            kind: "tool_call_started",
            toolCallId,
            toolName: name,
            input,
          });
        }
        // An explicit abort may land while the durable start event is being
        // written. Re-check before any mutating runtime begins.
        try {
          abortSignal?.throwIfAborted();
          const output = await executeCodingTool(name, input as never, {
            ...options,
            approved,
            abortSignal,
          });
          if (context.parentSessionId && recordToolEvent) {
            await recordToolEvent({
              sessionId: context.parentSessionId,
              kind: "tool_call_result",
              toolCallId,
              toolName: name,
              output,
            });
          }
          return output;
        } catch (error) {
          if (context.parentSessionId && recordToolEvent) {
            await recordToolEvent({
              sessionId: context.parentSessionId,
              kind: "tool_call_error",
              toolCallId,
              toolName: name,
              error: {
                ...(error instanceof Error && error.name
                  ? { name: error.name }
                  : {}),
                message: error instanceof Error ? error.message : String(error),
              },
            });
          }
          throw error;
        }
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
  /** Durable server-owned lifecycle recorder for locally executed tools. */
  recordToolEvent?: RecordCodingAgentToolEvent;
  /** Search is omitted when unavailable; provider tools replace the local one. */
  webSearch?: {
    available: boolean;
    providerTool?: ToolSet[string];
  };
}

export function resolveCodingAgentCallSettings({
  options,
  prompt,
  messages,
  promptOverride,
  includeToolDiscipline,
  providerWebSearchTool = false,
}: {
  options: CodingAgentCallOptions;
  prompt: unknown;
  messages: unknown;
  promptOverride?: string | null;
  includeToolDiscipline: boolean;
  /** True only when `web_search` executes inside the provider request. */
  providerWebSearchTool?: boolean;
}) {
  const mode = options.mode ?? defaultCodingAgentMode;
  const modeDefinition = getCodingAgentModeDefinition(mode);
  const intentTools = selectCodingAgentIntentTools({ mode, prompt, messages });
  const policyTools = getActiveCodingToolsForPolicy({
    modeTools: intentTools.filter((toolName) =>
      modeDefinition.activeTools.includes(toolName),
    ),
    mode,
    permissionMode: options.permissionMode,
    allowedTools: options.allowedTools,
    permissionRules: options.permissionRules,
  });
  const providerWebSearchAccess =
    providerWebSearchTool && intentTools.includes("web_search")
    ? resolveProviderWebSearchAccess({
        mode,
        permissionMode: options.permissionMode,
        allowedTools: options.allowedTools,
        permissionRules: options.permissionRules,
        decision: options.providerWebSearchDecision,
      })
    : null;
  const providerGatedTools =
    providerWebSearchAccess?.action === "expose"
      ? policyTools
      : providerWebSearchAccess
        ? policyTools.filter((toolName) => toolName !== "web_search")
        : policyTools;
  const activeTools = limitProviderActiveTools(providerGatedTools);
  const instructions = buildCodingAgentSystemPrompt({
    cwd: options.cwd,
    override: promptOverride,
    mode,
    includeToolDiscipline,
    environmentContext: options.environmentContext,
  });

  return {
    mode,
    policyTools: providerGatedTools,
    activeTools,
    instructions,
    providerWebSearchAccess,
  };
}

/** Activates schema-discovered tools on later steps without bypassing policy. */
export function resolveCodingAgentStepActiveTools({
  context,
  messages,
  availableToolNames,
  providerWebSearchTool,
}: {
  context: Partial<CodingAgentExecutionContext>;
  messages: readonly unknown[];
  availableToolNames: readonly CodingToolName[];
  providerWebSearchTool: boolean;
}): CodingToolName[] {
  const mode = context.mode ?? defaultCodingAgentMode;
  const modeDefinition = getCodingAgentModeDefinition(mode);
  const requested = new Set<CodingToolName>([
    ...(context.activeTools ?? []),
    ...collectToolSearchDiscoveredTools({ messages, mode }),
  ]);
  const modeTools = modeDefinition.activeTools.filter((toolName) =>
    requested.has(toolName),
  );
  let permitted = getActiveCodingToolsForPolicy({
    modeTools,
    mode,
    permissionMode: context.permissionMode,
    allowedTools: context.allowedTools,
    permissionRules: context.permissionRules,
  });

  if (providerWebSearchTool && permitted.includes("web_search")) {
    const access = resolveProviderWebSearchAccess({
      mode,
      permissionMode: context.permissionMode,
      allowedTools: context.allowedTools,
      permissionRules: context.permissionRules,
      decision: context.providerWebSearchDecision,
    });
    if (access.action !== "expose") {
      permitted = permitted.filter((toolName) => toolName !== "web_search");
    }
  }

  const available = new Set(availableToolNames);
  return limitProviderActiveTools(
    permitted.filter((toolName) => available.has(toolName)),
  );
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
  recordToolEvent,
  webSearch = { available: true },
}: CreateCodingAgentOptions) {
  const tools = createCodingAgentTools(runSubagent, recordToolEvent);
  if (!webSearch.available) {
    delete tools.web_search;
  } else if (webSearch.providerTool) {
    // Provider-executed search must be gated before the request. By the time a
    // provider tool call is returned, search/billing may already have happened.
    tools.web_search = webSearch.providerTool;
  }

  return new ToolLoopAgent<CodingAgentCallOptions, typeof tools>({
    model,
    tools,
    stopWhen: stepCountIs(maxSteps),
    maxOutputTokens,
    maxRetries,
    providerOptions,
    prepareStep: async ({ messages, experimental_context }) => {
      const context = readExecutionContext(experimental_context);
      if (
        !context.contextWindow ||
        !context.reservedOutputTokens ||
        context.preserveRecentTokens === undefined
      ) {
        return undefined;
      }

      const instructions = buildCodingAgentSystemPrompt({
        cwd: context.cwd ?? process.cwd(),
        override: promptOverride,
        mode: context.mode ?? defaultCodingAgentMode,
        includeToolDiscipline,
        environmentContext: context.environmentContext,
      });
      const activeTools = resolveCodingAgentStepActiveTools({
        context,
        messages,
        availableToolNames: Object.keys(tools) as CodingToolName[],
        providerWebSearchTool: Boolean(webSearch.providerTool),
      });
      const assembler = new ProviderTurnAssembler({
        system: instructions,
        tools,
        activeTools,
        contextWindow: context.contextWindow,
        reservedOutputTokens: context.reservedOutputTokens,
        originalInputTokens: context.originalInputTokens,
      });
      const artifactized = await artifactizeLargeToolOutputs(messages, {
        signal: context.assemblyAbortSignal,
      });
      const assembled = assembler.assembleModelMessages(artifactized.messages, {
        preserveRecentTokens: context.preserveRecentTokens,
      });

      codingAgentLogger.debug("coding_agent_provider_turn", {
        inputTokens: assembled.breakdown.inputTokens,
        inputBudgetTokens: assembled.breakdown.inputBudgetTokens,
        systemTokens: assembled.breakdown.systemTokens,
        toolTokens: assembled.breakdown.toolTokens,
        messageTokens: assembled.breakdown.messageTokens,
        mediaTokens: assembled.breakdown.mediaTokens,
        remainingTokens: assembled.breakdown.remainingTokens,
        fitted: assembled.fit.fitted,
        withinBudget: assembled.withinBudget,
      });

      if (!assembled.withinBudget) {
        throw new Error(
          "context_input_too_large: the latest user request cannot fit the model context window without truncation.",
        );
      }

      return {
        system: instructions,
        messages: assembled.messages,
        activeTools: activeTools as Array<keyof typeof tools>,
      };
    },
    // Weak models misname tools or emit malformed argument JSON; repair
    // deterministically instead of failing the step.
    experimental_repairToolCall: repairCodingAgentToolCall,
    callOptionsSchema: codingAgentCallOptionsSchema,
    prepareCall: ({ options, prompt, messages, ...settings }) => {
      const { mode, policyTools, activeTools, instructions } =
        resolveCodingAgentCallSettings({
          options,
          prompt,
          messages,
          promptOverride,
          includeToolDiscipline,
          providerWebSearchTool: Boolean(webSearch.providerTool),
        });
      const availableActiveTools = activeTools.filter(
        (toolName) => tools[toolName] !== undefined,
      );

      codingAgentLogger.debug("coding_agent_active_tools", {
        mode,
        requestedTools: policyTools,
        activeTools: availableActiveTools,
        toolsDisabled: availableActiveTools.length === 0,
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
        tools: availableActiveTools.length > 0 ? settings.tools : undefined,
        activeTools:
          availableActiveTools.length > 0 ? availableActiveTools : undefined,
        // Server-executed tools read the per-request context from here; the
        // interactive tools execute on the client and never see it.
        experimental_context: {
          cwd: options.cwd,
          parentSessionId: options.sessionId,
          mode,
          permissionMode: options.permissionMode,
          providerWebSearchDecision: options.providerWebSearchDecision,
          allowedTools: options.allowedTools,
          permissionRules: options.permissionRules,
          sandbox: options.sandbox,
          turnKey: options.turnKey,
          environmentContext: options.environmentContext,
          activeTools: availableActiveTools,
          contextWindow: options.contextWindow,
          reservedOutputTokens: options.maxOutputTokens,
          preserveRecentTokens: options.preserveRecentTokens,
          originalInputTokens: options.originalInputTokens,
          assemblyAbortSignal: options.assemblyAbortSignal,
        } satisfies CodingAgentExecutionContext,
        instructions,
      };
    },
  });
}

export type CodingAgentUIMessage = InferAgentUIMessage<ReturnType<typeof createCodingAgent>>;
