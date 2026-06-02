import { describe, expect, test } from "bun:test";
import {
  subagentTaskCreateRequestSchema,
  subagentTaskSchema,
} from "./subagent-schemas";

const parentSessionId = "11111111-1111-4111-8111-111111111111";

describe("subagent task schemas", () => {
  test("parses create requests with validated allowed tools", () => {
    const parsed = subagentTaskCreateRequestSchema.parse({
      parentSessionId,
      prompt: "Inspect the workspace and summarize likely entrypoints.",
      mode: "plan",
      model: "claude-sonnet",
      allowedTools: ["list_files", "read_file", "grep"],
    });

    expect(parsed.allowedTools).toEqual(["list_files", "read_file", "grep"]);
  });

  test("rejects tools outside the coding-agent tool vocabulary", () => {
    expect(() =>
      subagentTaskCreateRequestSchema.parse({
        parentSessionId,
        prompt: "Explore.",
        allowedTools: ["delete_everything"],
      })
    ).toThrow();
  });

  test("parses persisted lifecycle statuses and output", () => {
    const now = new Date("2026-06-03T00:00:00.000Z").toISOString();
    const parsed = subagentTaskSchema.parse({
      id: "22222222-2222-4222-8222-222222222222",
      parentSessionId,
      prompt: "Verify the implementation.",
      status: "blocked_on_provider",
      mode: "plan",
      model: null,
      allowedTools: ["git_status"],
      output: { summary: "Waiting for provider quota." },
      error: null,
      startedAt: now,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    expect(parsed.status).toBe("blocked_on_provider");
    expect(parsed.output).toEqual({ summary: "Waiting for provider quota." });
  });
});
