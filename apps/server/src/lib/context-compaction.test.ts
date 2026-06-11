import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
  createParityMockLanguageModel,
  type ParityMockScenario,
} from "@lightcode/ai/testing";
import { normalizeContextOptimizerConfig } from "@lightcode/ai";

function textMessage(role: UIMessage["role"], id: string, text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

const coveredMessages = [
  textMessage("user", "u0", "Please refactor packages/ai/src/agent-tools.ts."),
  textMessage(
    "assistant",
    "a0",
    "I refactored agent-tools.ts and the remaining work is pending tests.",
  ),
  textMessage("user", "u1", "Now add tests for the refactor."),
  textMessage(
    "assistant",
    "a1",
    "Tests added in packages/ai/src/agent-tools.test.ts.",
  ),
];

const config = normalizeContextOptimizerConfig(undefined);

function llmScenario(text: string): ParityMockScenario {
  return {
    id: "compaction-summary",
    steps: [{ type: "text", text }],
  };
}

describe("compactSessionContext", () => {
  test("stores an LLM summary with pinned sections and anchor", async () => {
    const { createChatSession, deleteChatSession } = await import("./chat-store");
    const { compactSessionContext } = await import("./context-compaction");
    const { getSessionContextState } = await import("./context-state-store");

    const session = await createChatSession({
      cwd: process.cwd(),
      title: "context compaction llm test",
    });

    try {
      const model = createParityMockLanguageModel({
        scenario: llmScenario(
          "## User intent and decisions\nRefactor agent tools.\n## Current state\nDone.\n## Key files\n- packages/ai/src/agent-tools.ts\n## Pending work and next steps\nNone.\n## Tools and commands that mattered\nbun test.",
        ),
      });

      const result = await compactSessionContext({
        sessionId: session.id,
        coveredMessages,
        previousState: null,
        model,
        modelId: "lightcode-parity-model",
        cwd: process.cwd(),
        config,
        estimatedTokens: 12_345,
      });

      expect(result.usedFallback).toBe(false);
      expect(result.state.tier).toBe("llm");
      expect(result.state.anchorMessageId).toBe("a1");
      expect(result.state.coveredMessageCount).toBe(coveredMessages.length);
      expect(result.state.estimatedTokens).toBe(12_345);
      expect(result.state.summary).toStartWith("Lightcode context summary");
      expect(result.state.summary).toContain("agent-tools.ts");

      const persisted = await getSessionContextState(session.id);
      expect(persisted?.summary).toBe(result.state.summary);
    } finally {
      await deleteChatSession(session.id);
    }
  });

  test("falls back to the heuristic summary when the model call fails", async () => {
    const { createChatSession, deleteChatSession } = await import("./chat-store");
    const { compactSessionContext } = await import("./context-compaction");

    const session = await createChatSession({
      cwd: process.cwd(),
      title: "context compaction fallback test",
    });

    try {
      const model = createParityMockLanguageModel({
        scenario: {
          id: "compaction-failure",
          steps: [],
          throwOnGenerate: new Error("Mock provider failure."),
        },
      });

      const result = await compactSessionContext({
        sessionId: session.id,
        coveredMessages,
        previousState: null,
        model,
        modelId: "lightcode-parity-model",
        cwd: process.cwd(),
        config,
        estimatedTokens: 9_999,
      });

      expect(result.usedFallback).toBe(true);
      expect(result.state.tier).toBe("heuristic");
      expect(result.state.anchorMessageId).toBe("a1");
      // The extractive fallback still captures the key facts.
      expect(result.state.summary).toContain("Lightcode context summary");
      expect(result.state.summary).toContain("packages/ai/src/agent-tools.ts");
    } finally {
      await deleteChatSession(session.id);
    }
  });

  test("folds the previous summary into repeated compactions", async () => {
    const { createChatSession, deleteChatSession } = await import("./chat-store");
    const { compactSessionContext } = await import("./context-compaction");

    const session = await createChatSession({
      cwd: process.cwd(),
      title: "context compaction repeat test",
    });

    try {
      const model = createParityMockLanguageModel({
        scenario: llmScenario("## Current state\nSecond round summary."),
      });

      const previous = await compactSessionContext({
        sessionId: session.id,
        coveredMessages: coveredMessages.slice(0, 2),
        previousState: null,
        model: createParityMockLanguageModel({
          scenario: llmScenario("## Current state\nFirst round summary."),
        }),
        modelId: "lightcode-parity-model",
        cwd: process.cwd(),
        config,
        estimatedTokens: 1_000,
      });

      const second = await compactSessionContext({
        sessionId: session.id,
        coveredMessages: coveredMessages.slice(2),
        previousState: previous.state,
        model,
        modelId: "lightcode-parity-model",
        cwd: process.cwd(),
        config,
        estimatedTokens: 2_000,
      });

      expect(second.state.anchorMessageId).toBe("a1");
      expect(second.state.coveredMessageCount).toBe(coveredMessages.length);
      expect(second.state.summary).toContain("Second round summary");
    } finally {
      await deleteChatSession(session.id);
    }
  });
});
