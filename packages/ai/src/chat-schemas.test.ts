import { describe, expect, test } from "bun:test";
import {
  sessionExportJsonSchema,
  sessionPathParamsSchema,
} from "./chat-schemas";

const sessionMetadata = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Test session",
  cwd: "D:/Self-Project/lightcode",
  mode: "build",
  permissionMode: "workspace-write",
  model: "claude-haiku-4-5",
  revision: 1,
  createdAt: "2026-05-30T00:00:00.000Z",
  updatedAt: "2026-05-30T00:01:00.000Z",
} as const;

describe("session chat schemas", () => {
  test("accepts strict UUID session ids and latest resume identifier", () => {
    expect(
      sessionPathParamsSchema.safeParse({
        id: sessionMetadata.id,
      }).success,
    ).toBe(true);
    expect(
      sessionPathParamsSchema.safeParse({
        id: "latest",
      }).success,
    ).toBe(true);
    expect(
      sessionPathParamsSchema.safeParse({
        id: "not-a-session-id",
      }).success,
    ).toBe(false);
  });

  test("validates exported session JSON", () => {
    const parsed = sessionExportJsonSchema.safeParse({
      exportedAt: "2026-05-30T00:02:00.000Z",
      session: sessionMetadata,
      messages: [
        {
          id: "message-0",
          role: "user",
          parts: [{ type: "text", text: "Hello" }],
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });
});
