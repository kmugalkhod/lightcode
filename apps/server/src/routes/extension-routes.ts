import { zValidator } from "@hono/zod-validator";
import {
  listPlugins,
  listSkills,
  loadSkill,
  skillListOutputSchema,
  skillOutputSchema,
} from "@lightcode/ai";
import { Hono } from "hono";
import { z } from "zod";
import { mcpServerManager } from "../lib/extension-runtime";

const skillParamsSchema = z.object({
  name: z.string().min(1).max(160),
});

const mcpServerParamsSchema = z.object({
  name: z.string().min(1).max(120),
});

export const extensionRoutes = new Hono()
  .get("/skills", (c) => {
    return c.json(
      skillListOutputSchema.parse({
        skills: listSkills({ cwd: process.cwd() }),
      }),
    );
  })
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
