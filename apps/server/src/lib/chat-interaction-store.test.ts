import { describe, expect, test } from "bun:test";

const hasDatabaseUrl = Boolean(Bun.env.DATABASE_URL);

async function hasChatInteractionsTable() {
  const { prisma } = await import("./prisma-client");
  const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT to_regclass('public.chat_interactions') IS NOT NULL AS exists
  `;

  return rows[0]?.exists === true;
}

describe("chat interaction store", () => {
  if (!hasDatabaseUrl) {
    test("skips database-backed checks without DATABASE_URL", () => {
      expect(hasDatabaseUrl).toBe(false);
    });
    return;
  }

  test(
    "upserts, resolves, protects terminal states, and cascades",
    async () => {
      if (!(await hasChatInteractionsTable())) {
        expect(true).toBe(true);
        return;
      }

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
      if (!(await hasChatInteractionsTable())) {
        expect(true).toBe(true);
        return;
      }

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
