import { zValidator } from "@hono/zod-validator";
import {
  listPlugins,
  listSkills,
  loadSkill,
  sessionIdentifierSchema,
  skillListOutputSchema,
  skillOutputSchema,
} from "@lightcode/ai";
import { Hono } from "hono";
import { z } from "zod";
import { mcpServerManager } from "../lib/extension-runtime";
import {
  loadChatSessionWithMessages,
  SessionNotFoundError,
} from "../lib/chat-store";

const skillParamsSchema = z.object({
  name: z.string().min(1).max(160),
});

const skillListQuerySchema = z.object({
  sessionId: sessionIdentifierSchema.optional(),
});

const mcpServerParamsSchema = z.object({
  name: z.string().min(1).max(120),
});

export const extensionRoutes = new Hono()
  .get(
    "/skills",
    zValidator("query", skillListQuerySchema),
    async (c) => {
      const { sessionId } = c.req.valid("query");
      let cwd = process.cwd();

      if (sessionId) {
        try {
          const { session } = await loadChatSessionWithMessages(sessionId);
          if (!session.cwd) {
            return c.json(
              { error: "Session has no canonical workspace directory." },
              409,
            );
          }
          cwd = session.cwd;
        } catch (error) {
          if (error instanceof SessionNotFoundError) {
            return c.json({ error: error.message }, 404);
          }
          throw error;
        }
      }

      return c.json(
        skillListOutputSchema.parse({
          skills: listSkills({ cwd }),
        }),
      );
    },
  )
  .get("/skills/:name", zValidator("param", skillParamsSchema), (c) => {
    const { name } = c.req.valid("param");
    return c.json(skillOutputSchema.parse(loadSkill({ name })));
  })
  .get("/mcp/servers", (c) => c.json({ servers: mcpServerManager.listServers() }))
  .get("/mcp/servers/:name", zValidator("param", mcpServerParamsSchema), (c) => {
    const { name } = c.req.valid("param");
    const server = mcpServerManager.inspectServer(name);
    return server ? c.json({ server }) : c.json({ error: "MCP server not found." }, 404);
  })
  .post("/mcp/servers/:name/start", zValidator("param", mcpServerParamsSchema), (c) => {
    const { name } = c.req.valid("param");
    return c.json({ server: mcpServerManager.startServer(name) });
  })
  .post("/mcp/servers/:name/stop", zValidator("param", mcpServerParamsSchema), (c) => {
    const { name } = c.req.valid("param");
    return c.json({ server: mcpServerManager.stopServer(name) });
  })
  .get("/plugins", (c) => c.json({ plugins: listPlugins({ cwd: process.cwd() }) }));
