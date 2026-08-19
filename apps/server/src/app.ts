import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createWebSecurityMiddleware } from "./lib/web-auth";
import { sessionRoutes } from "./routes/chat-routes";
import { configRoutes } from "./routes/config-routes";
import { diagnosticsRoutes } from "./routes/diagnostics-routes";
import { extensionRoutes } from "./routes/extension-routes";
import { rootRoutes } from "./routes/root-routes";
import { webRoutes } from "./routes/web-routes";
import { workspaceRoutes } from "./routes/workspace-routes";

const maxRequestBodyBytes = 32 * 1024 * 1024;

export const app = new Hono()
  .use("*", createWebSecurityMiddleware())
  .use(
    bodyLimit({
      maxSize: maxRequestBodyBytes,
      onError: (c) => c.json({ error: "Request body too large." }, 413),
    }),
  )
  .get("/healthz", (c) =>
    c.json({ ok: true, service: "lightcode", protocolVersion: 1 }),
  )
  .route("/", webRoutes)
  .route("/", rootRoutes)
  .route("/config", configRoutes)
  .route("/diagnostics", diagnosticsRoutes)
  .route("/extensions", extensionRoutes)
  .route("/workspaces", workspaceRoutes)
  .route("/sessions", sessionRoutes);
