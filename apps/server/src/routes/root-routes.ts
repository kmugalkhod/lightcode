import { createGreeting, productName } from "@lightcode/shared";
import { Hono } from "hono";

// /config/status now lives in config-routes.ts alongside the model endpoints.
export const rootRoutes = new Hono()
  .get("/", (c) => {
    return c.json({
      name: productName,
      message: createGreeting("API client"),
    });
  });
