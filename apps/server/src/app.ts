import { Hono } from "hono";
import { sessionRoutes } from "./routes/chat-routes";
import { rootRoutes } from "./routes/root-routes";

export const app = new Hono()
  .route("/", rootRoutes)
  .route("/sessions", sessionRoutes);
