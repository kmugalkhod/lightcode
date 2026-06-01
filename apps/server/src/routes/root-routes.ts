import { createGreeting, productName } from "@lightcode/shared";
import { Hono } from "hono";
import { configStatus } from "../lib/runtime-config";

export const rootRoutes = new Hono()
  .get("/", (c) => {
    return c.json({
      name: productName,
      message: createGreeting("API client"),
    });
  })
  .get("/config/status", (c) => {
    return c.json(configStatus);
  });
