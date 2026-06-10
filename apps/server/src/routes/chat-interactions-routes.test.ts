import { describe, expect, test } from "bun:test";
import {
  chatInteractionListResponseSchema,
  sessionCreateResponseSchema,
} from "@lightcode/ai";

describe("chat interaction routes", () => {
  test(
    "checkpoints, lists, and resolves interactions through Hono",
    async () => {
      const { app } = await import("../app");
      const createResponse = await app.request("/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          cwd: process.cwd(),
          title: "interaction route test",
        }),
      });
      const createdSession = sessionCreateResponseSchema.parse(
        await createResponse.json(),
      );
      const sessionId = createdSession.id;

      try {
        expect(createResponse.status).toBe(201);

        const upsertResponse = await app.request(
          `/sessions/${sessionId}/interactions`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              kind: "user_prompt",
              toolCallId: "question-1",
              payload: {
                question: "Proceed?",
                options: [{ label: "Yes" }],
              },
            }),
          },
        );
        expect(upsertResponse.status).toBe(201);

        const listResponse = await app.request(
          `/sessions/${sessionId}/interactions?status=pending`,
        );
        expect(listResponse.status).toBe(200);
        const listed = chatInteractionListResponseSchema.parse(
          await listResponse.json(),
        );
        expect(listed.interactions).toHaveLength(1);
        expect(listed.interactions[0].kind).toBe("user_prompt");

        const resolveResponse = await app.request(
          `/sessions/${sessionId}/interactions/question-1`,
          {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              status: "answered",
              response: {
                answer: "Yes",
                selectedOption: "Yes",
                source: "option",
              },
            }),
          },
        );
        expect(resolveResponse.status).toBe(200);

        const pendingResponse = await app.request(
          `/sessions/${sessionId}/interactions?status=pending`,
        );
        const pending = chatInteractionListResponseSchema.parse(
          await pendingResponse.json(),
        );
        expect(pending.interactions).toHaveLength(0);
      } finally {
        await app.request(`/sessions/${sessionId}`, {
          method: "DELETE",
        });
      }
    },
    15_000,
  );

  test(
    "returns validation errors for invalid interaction bodies",
    async () => {
      const { app } = await import("../app");
      const createResponse = await app.request("/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          cwd: process.cwd(),
          title: "interaction route validation test",
        }),
      });
      const createdSession = sessionCreateResponseSchema.parse(
        await createResponse.json(),
      );
      const sessionId = createdSession.id;

      try {
        const response = await app.request(`/sessions/${sessionId}/interactions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "tool_approval",
            toolCallId: "bad-tool",
            payload: {
              toolName: "not_a_tool",
            },
          }),
        });

        expect(response.status).toBe(400);
      } finally {
        await app.request(`/sessions/${sessionId}`, {
          method: "DELETE",
        });
      }
    },
    15_000,
  );
});
