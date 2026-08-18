import { describe, expect, test } from "bun:test";
import { createParityMockLanguageModel, parityMockScenarios } from "@lightcode/ai/testing";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSubagentToolTask } from "./subagent-runner";

async function withWorkspace(
  run: (cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), "lightcode-subagent-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("runSubagentToolTask", () => {
  test("replays the source-hashed AGENTS baseline in the provider system prompt", async () => {
    await withWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "AGENTS.md"), "Keep the subagent focused.");
      await writeFile(path.join(cwd, "README.md"), "README is not an instruction.");
      const model = createParityMockLanguageModel({
        scenario: parityMockScenarios.streamingText,
      });

      const result = await runSubagentToolTask(
        {
          description: "Inspect context",
          prompt: "Report the project rules.",
          profile: "explore",
        },
        { cwd },
        {
          model,
          modelId: "lightcode-parity-model",
          maxRetries: 0,
          contextWindow: 128_000,
          preserveRecentTokens: 12_000,
        },
      );

      expect(result.status).toBe("completed");
      expect(model.doGenerateCalls).toHaveLength(1);
      const wirePrompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
      expect(wirePrompt).toContain("Keep the subagent focused.");
      expect(wirePrompt).toContain('source=\\"AGENTS.md\\"');
      expect(wirePrompt).not.toContain("README is not an instruction.");
    });
  });

  test("does not call the provider when the task cannot fit", async () => {
    await withWorkspace(async (cwd) => {
      const model = createParityMockLanguageModel({
        scenario: parityMockScenarios.streamingText,
      });

      const result = await runSubagentToolTask(
        {
          description: "Oversized context",
          prompt: "x".repeat(30_000),
          profile: "explore",
        },
        { cwd },
        {
          model,
          modelId: "lightcode-parity-model",
          maxRetries: 0,
          contextWindow: 8_000,
          preserveRecentTokens: 12_000,
        },
      );

      expect(result.status).toBe("failed");
      expect(result.summary).toContain("context_input_too_large");
      expect(model.doGenerateCalls).toHaveLength(0);
    });
  });
});
