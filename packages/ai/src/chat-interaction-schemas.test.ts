import { describe, expect, test } from "bun:test";
import {
  chatInteractionResolveRequestSchema,
  chatInteractionToolApprovalPayloadSchema,
  chatInteractionUpsertRequestSchema,
} from "./chat-interaction-schemas";

describe("chat interaction schemas", () => {
  test("accepts a pending tool approval checkpoint", () => {
    const parsed = chatInteractionUpsertRequestSchema.parse({
      kind: "tool_approval",
      toolCallId: "tool-call-1",
      payload: {
        toolName: "bash",
        input: {
          command: "bun test",
        },
        summary: "bash bun test",
        permissionDecision: {
          outcome: "ask",
          toolName: "bash",
          activeMode: "workspace-write",
          requiredMode: "danger-full-access",
          reason: "Approval required.",
        },
        cwd: process.cwd(),
      },
    });

    expect(parsed.kind).toBe("tool_approval");
    if (parsed.kind !== "tool_approval") {
      throw new Error("Expected a tool approval interaction.");
    }
    expect(parsed.payload.toolName).toBe("bash");
  });

  test("accepts a pending user prompt checkpoint", () => {
    const parsed = chatInteractionUpsertRequestSchema.parse({
      kind: "user_prompt",
      toolCallId: "question-1",
      payload: {
        question: "Which approach should I use?",
        options: [
          {
            label: "Small patch",
            description: "Keep the change narrow.",
          },
        ],
      },
    });

    expect(parsed.kind).toBe("user_prompt");
    if (parsed.kind !== "user_prompt") {
      throw new Error("Expected a user prompt interaction.");
    }
    expect(parsed.payload.allowCustomResponse).toBe(true);
  });

  test("rejects non-json approval input", () => {
    expect(() =>
      chatInteractionToolApprovalPayloadSchema.parse({
        toolName: "bash",
        input: {
          command: "bun test",
          run: () => undefined,
        },
        summary: "bash bun test",
        permissionDecision: {
          outcome: "ask",
          toolName: "bash",
          activeMode: "workspace-write",
          requiredMode: "danger-full-access",
        },
        cwd: process.cwd(),
      }),
    ).toThrow();
  });

  test("requires answered interactions to carry a typed user response", () => {
    expect(() =>
      chatInteractionResolveRequestSchema.parse({
        status: "answered",
        response: {
          answer: "",
          source: "custom",
        },
      }),
    ).toThrow();

    expect(
      chatInteractionResolveRequestSchema.parse({
        status: "answered",
        response: {
          answer: "Use the small patch.",
          source: "custom",
        },
      }).status,
    ).toBe("answered");
  });
});
