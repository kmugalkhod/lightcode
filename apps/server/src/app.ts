import { Hono } from "hono";
import { sessionRoutes } from "./routes/chat-routes";
import { diagnosticsRoutes } from "./routes/diagnostics-routes";
import { extensionRoutes } from "./routes/extension-routes";
import { rootRoutes } from "./routes/root-routes";

export const app = new Hono()
  .route("/", rootRoutes)
  .route("/diagnostics", diagnosticsRoutes)
  .route("/extensions", extensionRoutes)
  .route("/sessions", sessionRoutes);
