import type { UIMessage } from "ai";
import {
  optimizeContextMessages,
  type ContextOptimizationResult,
  type ResolvedContextOptimizerConfig,
} from "@lightcode/ai";

export function prepareChatMessagesForProvider({
  messages,
  contextConfig,
  pendingInteractionCount = 0,
}: {
  messages: UIMessage[];
  contextConfig: ResolvedContextOptimizerConfig;
  pendingInteractionCount?: number;
}): ContextOptimizationResult {
  return optimizeContextMessages({
    messages,
    config: contextConfig,
    pendingInteractionCount,
  });
}

