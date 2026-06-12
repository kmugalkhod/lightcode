import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { sessionRoutes } from "./routes/chat-routes";
import { configRoutes } from "./routes/config-routes";
import { diagnosticsRoutes } from "./routes/diagnostics-routes";
import { extensionRoutes } from "./routes/extension-routes";
import { rootRoutes } from "./routes/root-routes";

const maxRequestBodyBytes = 32 * 1024 * 1024;

export const app = new Hono()
  .use(
    bodyLimit({
      maxSize: maxRequestBodyBytes,
      onError: (c) => c.json({ error: "Request body too large." }, 413),
    }),
  )
  .route("/", rootRoutes)
  .route("/config", configRoutes)
  .route("/diagnostics", diagnosticsRoutes)
  .route("/extensions", extensionRoutes)
  .route("/sessions", sessionRoutes);
