import { app } from "./app";
export { app };

if (import.meta.main) {
  const port = Number(Bun.env.PORT ?? 3000);

  Bun.serve({
    port,
    fetch: app.fetch,
  });

  console.log(`Server listening on http://localhost:${port}`);
}

export type AppType = typeof app;
