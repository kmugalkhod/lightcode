import { createGreeting, productName } from "@lightcode/shared";
import { Hono } from "hono";

export const rootRoutes = new Hono().get("/", (c) => {
  return c.json({
    name: productName,
    message: createGreeting("API client"),
  });
});
