import { createGreeting, productName } from "@lightcode/shared";
import { Hono } from "hono";

export const app = new Hono();

app.get("/", (c) => {
  return c.json({
    name: productName,
    message: createGreeting("API client"),
  });
});

app.get("/health", (c) => {
  return c.json({ ok: true });
});

if (import.meta.main) {
  const port = Number(Bun.env.PORT ?? 3000);

  Bun.serve({
    port,
    fetch: app.fetch,
  });

  console.log(`Server listening on http://localhost:${port}`);
}

export type AppType = typeof app;
