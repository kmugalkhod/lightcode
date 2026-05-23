import { app } from "./app";
export { app };

const httpIdleTimeoutSeconds = 30;

function isChatStreamingRoute(request: Request) {
  if (request.method !== "POST") {
    return false;
  }

  const pathname = new URL(request.url).pathname;
  return /^\/sessions\/[^/]+\/chat$/.test(pathname);
}

if (import.meta.main) {
  const port = Number(Bun.env.PORT ?? 3000);

  Bun.serve({
    idleTimeout: httpIdleTimeoutSeconds,
    port,
    async fetch(request, server) {
      if (isChatStreamingRoute(request)) {
        server.timeout(request, 0);
      }

      return app.fetch(request);
    },
  });

  console.log(`Server listening on http://localhost:${port}`);
}

export type AppType = typeof app;
