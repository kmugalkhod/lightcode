import type {
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3ToolCall,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";

export type ParityMockStep =
  | {
      type: "text";
      text: string;
      id?: string;
    }
  | {
      type: "tool-call";
      toolName: string;
      input: unknown;
      toolCallId?: string;
    }
  | {
      type: "tool-input-deltas";
      toolName: string;
      inputDeltas: readonly string[];
      input: unknown;
      toolCallId?: string;
    }
  | {
      type: "error";
      error: unknown;
    }
  | {
      type: "disconnect";
      message?: string;
    };

export interface ParityMockScenario {
  id: string;
  steps: readonly ParityMockStep[];
  finishReason?: LanguageModelV3FinishReason["unified"];
  throwOnGenerate?: Error;
  throwOnStream?: Error;
}

export interface ParityMockLanguageModelOptions {
  scenario: ParityMockScenario;
  provider?: string;
  modelId?: string;
}

const defaultUsage = {
  inputTokens: {
    total: 0,
    noCache: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  outputTokens: {
    total: 0,
    text: 0,
    reasoning: 0,
  },
} satisfies LanguageModelV3Usage;

function finishReason(
  unified: LanguageModelV3FinishReason["unified"],
): LanguageModelV3FinishReason {
  return {
    unified,
    raw: unified,
  };
}

function stringifyInput(input: unknown) {
  return JSON.stringify(input ?? {});
}

function toToolCall(step: Extract<ParityMockStep, { type: "tool-call" | "tool-input-deltas" }>): LanguageModelV3ToolCall {
  return {
    type: "tool-call",
    toolCallId: step.toolCallId ?? `${step.toolName}-call`,
    toolName: step.toolName,
    input: stringifyInput(step.input),
  };
}

function inferFinishReason(
  scenario: ParityMockScenario,
): LanguageModelV3FinishReason["unified"] {
  if (scenario.finishReason) {
    return scenario.finishReason;
  }

  if (scenario.steps.some((step) => step.type === "error")) {
    return "error";
  }

  if (
    scenario.steps.some(
      (step) => step.type === "tool-call" || step.type === "tool-input-deltas",
    )
  ) {
    return "tool-calls";
  }

  return "stop";
}

function toGenerateContent(steps: readonly ParityMockStep[]): LanguageModelV3Content[] {
  return steps.flatMap((step): LanguageModelV3Content[] => {
    switch (step.type) {
      case "text":
        return [{ type: "text", text: step.text }];
      case "tool-call":
      case "tool-input-deltas":
        return [toToolCall(step)];
      case "error":
      case "disconnect":
        return [];
    }
  });
}

function toStreamParts(steps: readonly ParityMockStep[]): {
  parts: LanguageModelV3StreamPart[];
  disconnectMessage: string | null;
} {
  const parts: LanguageModelV3StreamPart[] = [];
  let disconnectMessage: string | null = null;

  for (const [index, step] of steps.entries()) {
    switch (step.type) {
      case "text": {
        const id = step.id ?? `text-${index}`;
        parts.push(
          { type: "text-start", id },
          { type: "text-delta", id, delta: step.text },
          { type: "text-end", id },
        );
        break;
      }
      case "tool-call": {
        parts.push(toToolCall(step));
        break;
      }
      case "tool-input-deltas": {
        const id = step.toolCallId ?? `${step.toolName}-call`;
        parts.push({ type: "tool-input-start", id, toolName: step.toolName });
        for (const delta of step.inputDeltas) {
          parts.push({ type: "tool-input-delta", id, delta });
        }
        parts.push({ type: "tool-input-end", id }, toToolCall({ ...step, toolCallId: id }));
        break;
      }
      case "error": {
        parts.push({ type: "error", error: step.error });
        break;
      }
      case "disconnect": {
        disconnectMessage = step.message ?? "Mock provider stream disconnected.";
        break;
      }
    }
  }

  return { parts, disconnectMessage };
}

function streamWithOptionalDisconnect(
  parts: readonly LanguageModelV3StreamPart[],
  disconnectMessage: string | null,
) {
  if (!disconnectMessage) {
    return simulateReadableStream({
      chunks: [...parts],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    });
  }

  let index = 0;

  return new ReadableStream<LanguageModelV3StreamPart>({
    pull(controller) {
      if (index < parts.length) {
        controller.enqueue(parts[index]);
        index += 1;
        return;
      }

      controller.error(new Error(disconnectMessage));
    },
  });
}

function createGenerateResult(scenario: ParityMockScenario): LanguageModelV3GenerateResult {
  const unifiedFinishReason = inferFinishReason(scenario);

  return {
    content: toGenerateContent(scenario.steps),
    finishReason: finishReason(unifiedFinishReason),
    usage: defaultUsage,
    warnings: [],
    response: {
      id: `lightcode-parity-${scenario.id}`,
      modelId: "lightcode-parity-model",
      timestamp: new Date(0),
    },
  };
}

function createStreamResult(scenario: ParityMockScenario): LanguageModelV3StreamResult {
  const unifiedFinishReason = inferFinishReason(scenario);
  const { parts, disconnectMessage } = toStreamParts(scenario.steps);
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "stream-start", warnings: [] },
    ...parts,
  ];

  if (!disconnectMessage) {
    chunks.push({
      type: "finish",
      finishReason: finishReason(unifiedFinishReason),
      usage: defaultUsage,
    });
  }

  return {
    stream: streamWithOptionalDisconnect(chunks, disconnectMessage),
    request: {
      body: {
        scenario: scenario.id,
      },
    },
  };
}

export function createParityMockLanguageModel({
  scenario,
  provider = "lightcode-parity",
  modelId = "lightcode-parity-model",
}: ParityMockLanguageModelOptions) {
  return new MockLanguageModelV3({
    provider,
    modelId,
    doGenerate: async () => {
      if (scenario.throwOnGenerate) {
        throw scenario.throwOnGenerate;
      }

      return createGenerateResult(scenario);
    },
    doStream: async () => {
      if (scenario.throwOnStream) {
        throw scenario.throwOnStream;
      }

      return createStreamResult(scenario);
    },
  });
}

export const parityMockScenarios = {
  streamingText: {
    id: "streaming-text",
    steps: [{ type: "text", text: "Lightcode parity text." }],
  },
  readFileToolCall: {
    id: "read-file-tool-call",
    steps: [
      {
        type: "tool-call",
        toolName: "read_file",
        toolCallId: "read-file-1",
        input: { path: "README.md" },
      },
    ],
  },
  writeFileToolCall: {
    id: "write-file-tool-call",
    steps: [
      {
        type: "tool-call",
        toolName: "write_file",
        toolCallId: "write-file-1",
        input: {
          path: "tmp/reliability.txt",
          content: "reliability",
        },
      },
    ],
  },
  bashApprovalToolCall: {
    id: "bash-approval-tool-call",
    steps: [
      {
        type: "tool-call",
        toolName: "bash",
        toolCallId: "bash-1",
        input: {
          command: "bun test",
        },
      },
    ],
  },
  requestUserInputToolCall: {
    id: "request-user-input-tool-call",
    steps: [
      {
        type: "tool-call",
        toolName: "request_user_input",
        toolCallId: "question-1",
        input: {
          question: "Which implementation path should Lightcode take?",
          options: [{ label: "Small patch" }],
        },
      },
    ],
  },
  multiToolTurn: {
    id: "multi-tool-turn",
    steps: [
      {
        type: "tool-call",
        toolName: "read_file",
        toolCallId: "read-file-1",
        input: { path: "README.md" },
      },
      {
        type: "tool-call",
        toolName: "grep",
        toolCallId: "grep-1",
        input: { pattern: "Lightcode", path: "." },
      },
    ],
  },
  disconnectAfterToolCall: {
    id: "disconnect-after-tool-call",
    steps: [
      {
        type: "tool-call",
        toolName: "read_file",
        toolCallId: "read-file-1",
        input: { path: "README.md" },
      },
      { type: "disconnect", message: "Mock disconnect after tool call." },
    ],
  },
  toolCallDeltas: {
    id: "tool-call-deltas",
    steps: [
      {
        type: "tool-input-deltas",
        toolName: "grep",
        toolCallId: "grep-1",
        inputDeltas: ['{"pattern"', ':"TODO","path"', ':"src"}'],
        input: { pattern: "TODO", path: "src" },
      },
    ],
  },
  providerFailure: {
    id: "provider-failure",
    steps: [],
    throwOnStream: new Error("Mock provider failure."),
    throwOnGenerate: new Error("Mock provider failure."),
  },
  recoverableDisconnect: {
    id: "recoverable-disconnect",
    steps: [
      { type: "text", text: "Partial parity response." },
      { type: "disconnect", message: "Mock recoverable disconnect." },
    ],
  },
} satisfies Record<string, ParityMockScenario>;
