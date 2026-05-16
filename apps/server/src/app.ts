import { Hono } from "hono";
import { chatRoutes, sessionRoutes } from "./routes/chat-routes";
import { rootRoutes } from "./routes/root-routes";

export const app = new Hono()
  .route("/", rootRoutes)
  .route("/sessions", sessionRoutes)
  .route("/chat", chatRoutes);
