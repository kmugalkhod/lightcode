import { describe, expect, test } from "bun:test";
import { tool, type ModelMessage, type UIMessage } from "ai";
import { z } from "zod";
import { ProviderTurnAssembler } from "./provider-turn-assembler";

function textMessage(
  role: UIMessage["role"],
  id: string,
  text: string,
): UIMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

const tools = {
  read_file: tool({
    description: "Read a file from the workspace.",
    inputSchema: z.object({ path: z.string(), startLine: z.number().optional() }),
  }),
  bash: tool({
    description: "Run a shell command.",
    inputSchema: z.object({ command: z.string() }),
  }),
};

describe("ProviderTurnAssembler", () => {
  test("budgets system, active tool schemas, messages, media, and output together", () => {
    const assembler = new ProviderTurnAssembler({
      system: "Stable repository instructions.",
      tools,
      activeTools: ["read_file"],
      contextWindow: 8_000,
      reservedOutputTokens: 1_024,
    });
    const messages: UIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [
          { type: "text", text: "Inspect this image." },
          {
            type: "file",
            mediaType: "image/png",
            filename: "pixel.png",
            url: "data:image/png;base64," + "A".repeat(400),
          } as UIMessage["parts"][number],
        ],
      },
    ];

    const result = assembler.assembleUIMessages(messages, {
      preserveRecentTokens: 1_000,
    });

    expect(result.withinBudget).toBe(true);
    expect(result.breakdown.systemTokens).toBeGreaterThan(0);
    expect(result.breakdown.toolTokens).toBeGreaterThan(0);
    expect(result.breakdown.mediaTokens).toBeGreaterThan(0);
    expect(result.breakdown.inputTokens).toBe(
      result.breakdown.systemTokens +
        result.breakdown.toolTokens +
        result.breakdown.messageTokens +
        result.breakdown.mediaTokens,
    );
    expect(result.breakdown.inputTokens).toBeLessThanOrEqual(
      result.breakdown.inputBudgetTokens,
    );
  });

  test("only counts schemas for active tools", () => {
    const oneTool = new ProviderTurnAssembler({
      system: "system",
      tools,
      activeTools: ["read_file"],
      contextWindow: 8_000,
      reservedOutputTokens: 1_024,
    });
    const twoTools = new ProviderTurnAssembler({
      system: "system",
      tools,
      activeTools: ["read_file", "bash"],
      contextWindow: 8_000,
      reservedOutputTokens: 1_024,
    });

    expect(twoTools.toolTokens).toBeGreaterThan(oneTool.toolTokens);
  });

  test("never truncates an oversized latest user request", () => {
    const assembler = new ProviderTurnAssembler({
      system: "system",
      contextWindow: 8_000,
      reservedOutputTokens: 1_024,
    });
    const latest = textMessage("user", "u1", "x".repeat(100_000));

    const result = assembler.assembleUIMessages([latest], {
      preserveRecentTokens: 1_000,
    });

    expect(result.withinBudget).toBe(false);
    expect(result.messages[0]).toEqual(latest);
  });

  test("drops protected older model turns before rejecting a fitting latest request", () => {
    const assembler = new ProviderTurnAssembler({
      system: "system",
      contextWindow: 8_000,
      reservedOutputTokens: 1_024,
    });
    const latest: ModelMessage = {
      role: "user",
      content: "latest task must remain byte-identical",
    };
    const result = assembler.assembleModelMessages(
      [
        { role: "user", content: "x".repeat(40_000) },
        { role: "assistant", content: "y".repeat(40_000) },
        latest,
      ],
      { preserveRecentTokens: 100_000 },
    );

    expect(result.withinBudget).toBe(true);
    expect(result.messages).toEqual([latest]);
  });

  test("keeps every one of 15 growing tool-loop requests within budget", () => {
    const assembler = new ProviderTurnAssembler({
      system: "Stable instructions replayed on every step.",
      tools,
      activeTools: ["read_file"],
      contextWindow: 8_000,
      reservedOutputTokens: 1_024,
    });
    const messages: ModelMessage[] = [
      { role: "user", content: "Inspect the repository and finish the task." },
    ];

    for (let step = 0; step < 15; step += 1) {
      const toolCallId = `call-${step}`;
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId,
            toolName: "read_file",
            input: { path: `src/file-${step}.ts` },
          },
        ],
      });
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: "read_file",
            output: { type: "text", value: "x".repeat(20_000) },
          },
        ],
      });

      const result = assembler.assembleModelMessages(messages, {
        preserveRecentTokens: 1_500,
      });
      expect(result.withinBudget).toBe(true);
      expect(result.breakdown.inputTokens).toBeLessThanOrEqual(
        result.breakdown.inputBudgetTokens,
      );
      const retainedUser = result.messages.find(
        (message) => message.role === "user",
      );
      expect(retainedUser?.role).toBe("user");
      expect(retainedUser?.content).toBe(
        "Inspect the repository and finish the task.",
      );
    }
  });
});
