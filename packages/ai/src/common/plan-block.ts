import type { UIMessage } from "ai";
import { collectMessageText } from "../context/message-parts";

export const proposedPlanOpenTag = "<proposed_plan>";
export const proposedPlanCloseTag = "</proposed_plan>";

export function containsProposedPlanBlock(text: string): boolean {
  const openIndex = text.indexOf(proposedPlanOpenTag);
  if (openIndex === -1) {
    return false;
  }

  return text.includes(proposedPlanCloseTag, openIndex + proposedPlanOpenTag.length);
}

export function extractProposedPlanBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const openIndex = text.indexOf(proposedPlanOpenTag, cursor);
    if (openIndex === -1) {
      break;
    }

    const planStart = openIndex + proposedPlanOpenTag.length;
    const closeIndex = text.indexOf(proposedPlanCloseTag, planStart);
    if (closeIndex === -1) {
      break;
    }

    const plan = text.slice(planStart, closeIndex).trim();
    if (plan) {
      blocks.push(plan);
    }

    cursor = closeIndex + proposedPlanCloseTag.length;
  }

  return blocks;
}

/**
 * Finds the most recent proposed-plan block across assistant messages.
 * Used to pin the active plan into context-compaction summaries.
 */
export function extractLatestProposedPlan(
  messages: readonly UIMessage[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      continue;
    }

    const blocks = extractProposedPlanBlocks(collectMessageText(message));
    if (blocks.length > 0) {
      return blocks[blocks.length - 1];
    }
  }

  return null;
}
