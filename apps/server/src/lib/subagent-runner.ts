import {
  artifactizeLargeToolOutputs,
  buildSubagentSystemPrompt,
  capSubagentSummary,
  createSubagentToolset,
  defaultSubagentProfile,
  ProviderTurnAssembler,
  subagentProfileTools,
  type AgentToolInput,
  type AgentToolOutput,
  type CodingAgentExecutionContext,
  type SubagentTaskStatus,
} from "@lightcode/ai/runtime";
import { createLogger, getErrorMessage } from "@lightcode/shared";
import type { LanguageModel } from "ai";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { generateText, stepCountIs } from "ai";
import { createSubagentTask, updateSubagentTask } from "./subagent-task-store";
import { buildWorkspaceInstructionBaseline } from "./workspace-context";

const logger = createLogger("subagent-runner");

// A subagent is a bounded side quest, not a second full agent: fewer steps
// than the parent loop and a per-step output cap keep runaway cost impossible.
const subagentMaxSteps = 15;
const subagentMaxOutputTokens = 8_192;

export interface SubagentRunnerDeps {
  model: LanguageModel;
  modelId: string;
  providerOptions?: SharedV3ProviderOptions;
  maxRetries: number;
  contextWindow: number;
  preserveRecentTokens: number;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function updateTaskSafe(
  taskId: string | null,
  update: {
    status: SubagentTaskStatus;
    output?: { summary: string; truncated: boolean };
    error?: string;
  },
) {
  if (!taskId) {
    return;
  }

  try {
    await updateSubagentTask({ taskId, ...update });
  } catch (error) {
    logger.warn("subagent_task_update_failed", {
      taskId,
      error: getErrorMessage(error),
    });
  }
}

/**
 * Runs the `agent` tool: one subagent loop in a fresh context (LC-050). The
 * subagent shares nothing with the parent conversation — it gets only the
 * prompt, the source-hashed root instructions, a profile-restricted read-only
 * toolset, and the workspace cwd — and only its capped final summary flows
 * back into the parent context.
 *
 * Task rows are persisted best-effort so the lifecycle is inspectable
 * (LC-048/LC-053); a store failure never blocks the run itself.
 */
export async function runSubagentToolTask(
  input: AgentToolInput,
  context: CodingAgentExecutionContext & { abortSignal?: AbortSignal },
  deps: SubagentRunnerDeps,
): Promise<AgentToolOutput> {
  const profile = input.profile ?? defaultSubagentProfile;
  let taskId: string | null = null;

  if (context.parentSessionId) {
    try {
      const task = await createSubagentTask({
        parentSessionId: context.parentSessionId,
        prompt: input.prompt,
        mode: "plan",
        model: input.model ?? deps.modelId,
        allowedTools: subagentProfileTools[profile],
      });
      taskId = task.id;
      await updateTaskSafe(taskId, { status: "running" });
    } catch (error) {
      logger.warn("subagent_task_create_failed", {
        parentSessionId: context.parentSessionId,
        error: getErrorMessage(error),
      });
    }
  }

  logger.info("subagent_started", {
    taskId,
    profile,
    description: input.description,
    modelId: deps.modelId,
  });

  try {
    context.abortSignal?.throwIfAborted();
    const instructionBaseline = await buildWorkspaceInstructionBaseline({
      cwd: context.cwd,
    });
    const system = [
      buildSubagentSystemPrompt({ profile, cwd: context.cwd }),
      instructionBaseline.block,
    ].join("\n\n");
    const tools = createSubagentToolset(profile, { cwd: context.cwd });
    const activeTools = [...subagentProfileTools[profile]];
    const assembler = new ProviderTurnAssembler({
      system,
      tools,
      activeTools,
      contextWindow: deps.contextWindow,
      reservedOutputTokens: subagentMaxOutputTokens,
    });
    const preserveRecentTokens = Math.min(
      Math.max(0, deps.preserveRecentTokens),
      Math.floor(assembler.messageBudgetTokens * 0.2),
    );

    const result = await generateText({
      model: deps.model,
      system,
      prompt: input.prompt,
      tools,
      activeTools,
      stopWhen: stepCountIs(subagentMaxSteps),
      maxOutputTokens: subagentMaxOutputTokens,
      maxRetries: deps.maxRetries,
      providerOptions: deps.providerOptions,
      abortSignal: context.abortSignal,
      prepareStep: async ({ messages }) => {
        const artifactized = await artifactizeLargeToolOutputs(messages, {
          signal: context.abortSignal,
        });
        const turn = assembler.assembleModelMessages(artifactized.messages, {
          preserveRecentTokens,
        });
        logger.debug("subagent_provider_turn", {
          taskId,
          inputTokens: turn.breakdown.inputTokens,
          inputBudgetTokens: turn.breakdown.inputBudgetTokens,
          systemTokens: turn.breakdown.systemTokens,
          toolTokens: turn.breakdown.toolTokens,
          messageTokens: turn.breakdown.messageTokens,
          mediaTokens: turn.breakdown.mediaTokens,
          remainingTokens: turn.breakdown.remainingTokens,
          fitted: turn.fit.fitted,
          withinBudget: turn.withinBudget,
        });

        if (!turn.withinBudget) {
          throw new Error(
            "context_input_too_large: the subagent request cannot fit the model context window without truncating its task.",
          );
        }

        return {
          system,
          messages: turn.messages,
          activeTools,
        };
      },
    });

    const { summary, truncated } = capSubagentSummary(
      result.text.trim() ||
        "The subagent finished without producing a summary.",
    );

    await updateTaskSafe(taskId, {
      status: "completed",
      output: { summary, truncated },
    });
    logger.info("subagent_completed", {
      taskId,
      steps: result.steps.length,
      totalTokens: result.totalUsage.totalTokens,
      truncated,
    });

    return { taskId, status: "completed", summary, truncated };
  } catch (error) {
    if (context.abortSignal?.aborted || isAbortError(error)) {
      await updateTaskSafe(taskId, { status: "cancelled" });
      throw error;
    }

    const message = getErrorMessage(error);
    await updateTaskSafe(taskId, { status: "failed", error: message });
    logger.error("subagent_failed", { taskId, error: message });

    // Return a structured failure instead of throwing so the parent agent
    // sees what happened and can retry or work around it.
    return {
      taskId,
      status: "failed",
      summary: `Subagent failed: ${message}`,
      truncated: false,
    };
  }
}
