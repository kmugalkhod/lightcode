import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  sessionCreateResponseSchema,
  skillListOutputSchema,
} from "@lightcode/ai";

describe("extension routes", () => {
  test("lists skills from the saved session workspace", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "lightcode-skills-route-"));
    const workspace = path.join(tempRoot, "saved-workspace");
    const skillDirectory = path.join(
      workspace,
      ".lightcode",
      "skills",
      "saved-workspace-skill",
    );
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      path.join(skillDirectory, "SKILL.md"),
      [
        "---",
        "name: saved-workspace-skill",
        "description: Found through the session workspace",
        "---",
        "Use the saved workspace.",
      ].join("\n"),
      "utf8",
    );

    const { app } = await import("../app");
    const createResponse = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: workspace }),
    });
    const session = sessionCreateResponseSchema.parse(
      await createResponse.json(),
    );

    try {
      const response = await app.request(
        `/extensions/skills?sessionId=${encodeURIComponent(session.id)}`,
      );
      expect(response.status).toBe(200);
      const payload = skillListOutputSchema.parse(await response.json());
      expect(payload.skills).toContainEqual(
        expect.objectContaining({
          name: "saved-workspace-skill",
          source: "project",
        }),
      );
    } finally {
      await app.request(`/sessions/${session.id}`, { method: "DELETE" });
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
