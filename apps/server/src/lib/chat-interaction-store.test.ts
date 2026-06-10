import { describe, expect, test } from "bun:test";

describe("chat interaction store", () => {
  test(
    "upserts, resolves, protects terminal states, and cascades",
    async () => {
      const { createChatSession, deleteChatSession } = await import("./chat-store");
      const { prisma } = await import("./prisma-client");
      const {
        listChatInteractions,
        resolveChatInteraction,
        upsertChatInteraction,
      } = await import("./chat-interaction-store");
      const session = await createChatSession({
        cwd: process.cwd(),
        title: "interaction store test",
      });

      try {
        const checkpoint = await upsertChatInteraction({
          sessionId: session.id,
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
        const repeatedCheckpoint = await upsertChatInteraction({
          sessionId: session.id,
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
            },
            cwd: process.cwd(),
          },
        });

        expect(repeatedCheckpoint.id).toBe(checkpoint.id);
        expect(repeatedCheckpoint.status).toBe("pending");

        const resolved = await resolveChatInteraction({
          sessionId: session.id,
          toolCallId: "tool-call-1",
          status: "denied",
          response: {
            errorText: "Denied by test.",
          },
        });
        expect(resolved.status).toBe("denied");
        expect(typeof resolved.resolvedAt).toBe("string");

        const terminalCheckpoint = await upsertChatInteraction({
          sessionId: session.id,
          kind: "tool_approval",
          toolCallId: "tool-call-1",
          payload: {
            toolName: "bash",
            input: {
              command: "bun test --watch",
            },
            summary: "bash bun test --watch",
            permissionDecision: {
              outcome: "ask",
              toolName: "bash",
              activeMode: "workspace-write",
              requiredMode: "danger-full-access",
            },
            cwd: process.cwd(),
          },
        });
        expect(terminalCheckpoint.status).toBe("denied");

        const listed = await listChatInteractions({
          sessionId: session.id,
        });
        expect(listed.interactions).toHaveLength(1);

        await deleteChatSession(session.id);
        const remaining = await prisma.chatInteraction.count({
          where: {
            sessionId: session.id,
          },
        });
        expect(remaining).toBe(0);
      } finally {
        await deleteChatSession(session.id).catch(() => undefined);
      }
    },
    15_000,
  );

  test(
    "rejects invalid interaction payloads before writing",
    async () => {
      const { createChatSession, deleteChatSession } = await import("./chat-store");
      const { upsertChatInteraction } = await import("./chat-interaction-store");
      const session = await createChatSession({
        cwd: process.cwd(),
        title: "interaction invalid payload test",
      });

      try {
        await expect(
          upsertChatInteraction({
            sessionId: session.id,
            kind: "tool_approval",
            toolCallId: "bad-tool-call",
            payload: {
              toolName: "not_a_tool",
            },
          } as never),
        ).rejects.toThrow();
      } finally {
        await deleteChatSession(session.id).catch(() => undefined);
      }
    },
    15_000,
  );
});
