interface FetchHandler {
  fetch(request: Request): Response | Promise<Response>;
}

interface IdleTimeoutServer {
  timeout(request: Request, seconds: number): void;
}

/**
 * Routes that may legitimately stay silent longer than Bun's HTTP idle
 * timeout: chat streams, and the native folder picker, which waits on a
 * human. The picker route enforces its own hard cap instead.
 */
export function isLongRunningRoute(request: Request): boolean {
  if (request.method !== "POST") {
    return false;
  }

  const pathname = new URL(request.url).pathname;
  return (
    /^\/sessions\/[^/]+\/(?:chat|turns)$/.test(pathname) ||
    pathname === "/workspaces/picker/open"
  );
}

export function createServerFetch(app: FetchHandler) {
  return (request: Request, server: IdleTimeoutServer) => {
    if (isLongRunningRoute(request)) {
      server.timeout(request, 0);
    }

    return app.fetch(request);
  };
}
