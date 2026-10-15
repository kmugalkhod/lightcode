import { collectMessageText } from "@lightcode/ai";
import { createWorkspaceContext, loadSessionTodos } from "@lightcode/ai/runtime";
import type { UIMessage } from "ai";
import type { ChatInteractionSubmitPayload } from "../../components/chat/chat-interaction-popup";
import { containsProposedPlanBlock } from "../../components/chat/chat-proposed-plan-card";

export const autoImplementationInstruction =
  "Please implement the approved plan now. Execute the work end-to-end and summarize completed changes.";
export const defaultPlanRevisionRequest =
  "Please revise the plan with a different approach and ask clarifying questions if needed.";
export const defaultPromptDismissResponse =
  "I want to skip this question for now. Please continue with reasonable assumptions and state them clearly.";

export const loadCodingSessionTodos = ({
  sessionId,
  cwd,
}: {
  sessionId: string;
  cwd: string;
}) =>
  loadSessionTodos({
    sessionId,
    workspaceContext: createWorkspaceContext(cwd),
  });
const planConfirmationAcceptKeywords = [
  "yes",
  "y",
  "ok",
  "okay",
  "proceed",
  "continue",
  "implement",
  "start",
  "go",
];
const planConfirmationReviseKeywords = [
  "no",
  "n",
  "revise",
  "change",
  "modify",
  "update",
  "adjust",
  "different",
  "refine",
  "rework",
];

export function shouldImplementApprovedPlan(response: ChatInteractionSubmitPayload): boolean {
  if (response.selectedValue === "yes") {
    return true;
  }

  if (response.selectedValue === "no") {
    return false;
  }

  const normalizedAnswer = response.answer.trim().toLowerCase();
  if (!normalizedAnswer) {
    return false;
  }

  const normalizedTokens = normalizedAnswer.match(/[a-z]+/g) ?? [];
  const tokenSet = new Set(normalizedTokens);
  const hasAcceptKeyword = planConfirmationAcceptKeywords.some((keyword) =>
    tokenSet.has(keyword),
  );
  const hasReviseKeyword = planConfirmationReviseKeywords.some((keyword) =>
    tokenSet.has(keyword),
  );

  if (hasReviseKeyword) {
    return false;
  }

  return hasAcceptKeyword;
}

export function getLatestAssistantMessage(messages: UIMessage[]): UIMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      return message;
    }
  }

  return null;
}

export function hasProposedPlanBlock(message: UIMessage): boolean {
  return containsProposedPlanBlock(collectMessageText(message));
}

// Matches textual tool-call blocks (any dialect the middleware understands) like:
// <tool_call>{"name":"read_file","parameters":{...}}</tool_call>
// <function_call>{"name":"bash","arguments":{...}}</function_call>
// <invoke name="read_file">, <function=bash>, DeepSeek <｜tool▁call▁begin｜> markers
const TOOL_CALL_XML_RE =
  /<(?:tool_call|function_call)>|<invoke\s+name=|<function=[\w.-]+>|<｜tool▁call(?:s)?▁begin｜>/i;

export function hasToolCallXmlLeak(message: UIMessage): boolean {
  // Reset regex state to ensure consistent matching
  TOOL_CALL_XML_RE.lastIndex = 0;
  return TOOL_CALL_XML_RE.test(collectMessageText(message));
}

/**
 * Synthetic loop messages (auto-continue, nudges, stall retries) stay in
 * history for the model but are never rendered — limit handling is internal.
 */
export function isAutoContinueMessage(message: UIMessage): boolean {
  return (
    message.role === "user" &&
    typeof message.metadata === "object" &&
    message.metadata !== null &&
    Reflect.get(message.metadata, "autoContinue") === true
  );
}
