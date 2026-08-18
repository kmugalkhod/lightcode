import type { ModelMessage, SystemModelMessage, ToolSet, UIMessage } from "ai";
import { estimateTextTokens, safeStringify } from "./estimate";
import {
  fitMessagesToBudget,
  type FitToBudgetResult,
} from "./fit-to-budget";
import {
  fitModelMessagesToBudget,
  type FitModelMessagesToBudgetResult,
} from "./fit-model-messages-to-budget";
import { resolveInputBudgetTokens } from "./config";

type ProviderSystemPrompt = string | SystemModelMessage | SystemModelMessage[];

export interface ProviderTurnAssemblerOptions {
  system: ProviderSystemPrompt;
  tools?: ToolSet;
  activeTools?: readonly string[];
  contextWindow: number;
  reservedOutputTokens: number;
  /** Estimate before compaction/fitting, used only for savings telemetry. */
  originalInputTokens?: number;
}

export interface ProviderTurnTokenBreakdown {
  systemTokens: number;
  toolTokens: number;
  messageTokens: number;
  mediaTokens: number;
  inputTokens: number;
  inputBudgetTokens: number;
  messageBudgetTokens: number;
  reservedOutputTokens: number;
  contextWindow: number;
  remainingTokens: number;
  compactedTokens: number;
}

export interface AssembledProviderTurn<M, F> {
  system: ProviderSystemPrompt;
  messages: M[];
  activeTools: string[];
  breakdown: ProviderTurnTokenBreakdown;
  fit: F;
  withinBudget: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function schemaForEstimate(schema: unknown): unknown {
  try {
    if (typeof schema === "function") {
      return schemaForEstimate(schema());
    }
    if (!isRecord(schema)) {
      return null;
    }

    const standard = Reflect.get(schema, "~standard");
    if (isRecord(standard)) {
      const jsonSchema = Reflect.get(standard, "jsonSchema");
      const input = isRecord(jsonSchema) ? Reflect.get(jsonSchema, "input") : null;
      if (typeof input === "function") {
        const converted = input.call(jsonSchema, { target: "draft-07" });
        if (!isRecord(converted) || !("then" in converted)) {
          return converted;
        }
      }
    }

    const jsonSchema = Reflect.get(schema, "jsonSchema");
    return jsonSchema && !isRecord(jsonSchema)
      ? null
      : (jsonSchema ?? null);
  } catch {
    return null;
  }
}

export function estimateProviderToolTokens({
  tools,
  activeTools,
}: {
  tools?: ToolSet;
  activeTools?: readonly string[];
}): number {
  if (!tools) {
    return 0;
  }

  const names = activeTools ?? Object.keys(tools);
  return names.reduce((total, name) => {
    const tool = tools[name];
    if (!tool) {
      return total;
    }
    const providerTool = isRecord(tool) && tool.type === "provider";
    const wireShape = providerTool
      ? {
          name,
          id: Reflect.get(tool, "id"),
          args: Reflect.get(tool, "args"),
        }
      : {
          name,
          description: tool.description,
          inputSchema: schemaForEstimate(tool.inputSchema),
        };
    // Providers add a small per-function wrapper beyond the serialized JSON.
    return total + estimateTextTokens(safeStringify(wireShape)) + 8;
  }, 0);
}

export function estimateProviderSystemTokens(system: ProviderSystemPrompt): number {
  return estimateTextTokens(
    typeof system === "string" ? system : safeStringify(system),
  );
}

function estimateMediaValue(value: unknown): number {
  if (typeof value === "string") {
    return estimateTextTokens(value);
  }
  if (value instanceof Uint8Array) {
    return Math.ceil(value.byteLength / 3) + 1;
  }
  if (value instanceof ArrayBuffer) {
    return Math.ceil(value.byteLength / 3) + 1;
  }
  if (value instanceof URL) {
    return estimateTextTokens(value.href);
  }
  return estimateTextTokens(safeStringify(value));
}

export function estimateProviderMediaTokens(messages: readonly unknown[]): number {
  let tokens = 0;

  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }

    const type = Reflect.get(value, "type");
    if (type === "image") {
      tokens += estimateMediaValue(
        Reflect.get(value, "image") ?? Reflect.get(value, "url"),
      );
      return;
    }
    if (type === "file") {
      tokens += estimateMediaValue(
        Reflect.get(value, "data") ?? Reflect.get(value, "url"),
      );
      return;
    }

    for (const entry of Object.values(value)) {
      visit(entry);
    }
  };

  visit(messages);
  return tokens;
}

/**
 * Single source of truth for final provider-request accounting. It budgets the
 * exact system prompt, active tool grammar, messages, media, and output reserve
 * together, then fits only the ephemeral message view into what remains.
 */
export class ProviderTurnAssembler {
  readonly system: ProviderSystemPrompt;
  readonly tools: ToolSet | undefined;
  readonly activeTools: string[];
  readonly contextWindow: number;
  readonly reservedOutputTokens: number;
  readonly inputBudgetTokens: number;
  readonly systemTokens: number;
  readonly toolTokens: number;
  readonly fixedInputTokens: number;
  readonly messageBudgetTokens: number;
  readonly originalInputTokens: number;

  constructor(options: ProviderTurnAssemblerOptions) {
    this.system = options.system;
    this.tools = options.tools;
    this.activeTools = options.activeTools
      ? [...options.activeTools]
      : Object.keys(options.tools ?? {});
    this.contextWindow = Math.max(1, Math.floor(options.contextWindow));
    this.reservedOutputTokens = Math.max(
      0,
      Math.floor(options.reservedOutputTokens),
    );
    this.inputBudgetTokens = resolveInputBudgetTokens({
      contextWindow: this.contextWindow,
      reservedOutputTokens: this.reservedOutputTokens,
    });
    this.systemTokens = estimateProviderSystemTokens(this.system);
    this.toolTokens = estimateProviderToolTokens({
      tools: this.tools,
      activeTools: this.activeTools,
    });
    this.fixedInputTokens = this.systemTokens + this.toolTokens;
    this.messageBudgetTokens = Math.max(
      0,
      this.inputBudgetTokens - this.fixedInputTokens,
    );
    this.originalInputTokens = Math.max(
      0,
      Math.floor(options.originalInputTokens ?? 0),
    );
  }

  private breakdown(
    messages: readonly unknown[],
    fittedMessageTokens: number,
  ): ProviderTurnTokenBreakdown {
    const mediaTokens = Math.min(
      fittedMessageTokens,
      estimateProviderMediaTokens(messages),
    );
    const inputTokens = this.fixedInputTokens + fittedMessageTokens;
    return {
      systemTokens: this.systemTokens,
      toolTokens: this.toolTokens,
      messageTokens: Math.max(0, fittedMessageTokens - mediaTokens),
      mediaTokens,
      inputTokens,
      inputBudgetTokens: this.inputBudgetTokens,
      messageBudgetTokens: this.messageBudgetTokens,
      reservedOutputTokens: this.reservedOutputTokens,
      contextWindow: this.contextWindow,
      remainingTokens: Math.max(
        0,
        this.contextWindow - this.reservedOutputTokens - inputTokens,
      ),
      compactedTokens: Math.max(0, this.originalInputTokens - inputTokens),
    };
  }

  assembleUIMessages(
    messages: readonly UIMessage[],
    { preserveRecentTokens }: { preserveRecentTokens: number },
  ): AssembledProviderTurn<UIMessage, FitToBudgetResult> {
    const fit = fitMessagesToBudget(messages, {
      inputBudgetTokens: this.messageBudgetTokens,
      preserveRecentTokens,
    });
    const breakdown = this.breakdown(fit.messages, fit.estimatedTokens);
    return {
      system: this.system,
      messages: fit.messages,
      activeTools: this.activeTools,
      breakdown,
      fit,
      withinBudget:
        fit.withinBudget && breakdown.inputTokens <= this.inputBudgetTokens,
    };
  }

  assembleModelMessages(
    messages: readonly ModelMessage[],
    { preserveRecentTokens }: { preserveRecentTokens: number },
  ): AssembledProviderTurn<ModelMessage, FitModelMessagesToBudgetResult> {
    const fit = fitModelMessagesToBudget(messages, {
      inputBudgetTokens: this.messageBudgetTokens,
      preserveRecentTokens,
    });
    const breakdown = this.breakdown(fit.messages, fit.estimatedTokens);
    return {
      system: this.system,
      messages: fit.messages,
      activeTools: this.activeTools,
      breakdown,
      fit,
      withinBudget:
        fit.withinBudget && breakdown.inputTokens <= this.inputBudgetTokens,
    };
  }
}
