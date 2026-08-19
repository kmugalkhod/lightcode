import { lstatSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";

const webSecurityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

function resolveWebAssetsRoot(): string | null {
  const modulePath = fileURLToPath(import.meta.url);
  const moduleDirectory = path.dirname(modulePath);
  const candidates = [
    // Published package: server.js sits next to assets/web.
    path.resolve(moduleDirectory, "assets", "web"),
  ];
  const sourceSuffix = path.join(
    "apps",
    "server",
    "src",
    "routes",
    "web-routes.ts",
  );
  if (modulePath.endsWith(sourceSuffix)) {
    // Source checkout: apps/server/src/routes -> apps/web/dist.
    candidates.push(
      path.resolve(moduleDirectory, "..", "..", "..", "web", "dist"),
    );
  }

  for (const candidate of candidates) {
    try {
      const metadata = lstatSync(candidate);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        return realpathSync(candidate);
      }
    } catch {
      // Try the next known build layout.
    }
  }
  return null;
}

function applyWebHeaders(c: { header(name: string, value: string): void }) {
  for (const [name, value] of Object.entries(webSecurityHeaders)) {
    c.header(name, value);
  }
}

function getAssetRequestPath(pathname: string): string | null {
  const relativePath = pathname.replace(/^\/app\/?/, "");
  if (!relativePath) {
    return "index.html";
  }

  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\\") ||
        segment.includes("\0"),
    )
  ) {
    return null;
  }

  return segments.join(path.sep);
}

async function serveWebAsset(c: Context) {
  applyWebHeaders(c);
  const assetsRoot = resolveWebAssetsRoot();
  if (!assetsRoot) {
    return c.json(
      {
        error: "Lightcode web assets are not built.",
        code: "web_assets_unavailable",
      },
      503,
    );
  }

  const requestedPath = getAssetRequestPath(c.req.path);
  if (!requestedPath) {
    return c.json({ error: "Invalid asset path." }, 400);
  }

  const absolutePath = path.resolve(assetsRoot, requestedPath);
  const relativeToRoot = path.relative(assetsRoot, absolutePath);
  if (
    relativeToRoot.startsWith("..") ||
    path.isAbsolute(relativeToRoot)
  ) {
    return c.json({ error: "Invalid asset path." }, 400);
  }

  const safeFile = async (candidate: string): Promise<ReturnType<typeof Bun.file> | null> => {
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        return null;
      }
      const canonical = await realpath(candidate);
      const relative = path.relative(assetsRoot, canonical);
      if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
        return null;
      }
      return Bun.file(canonical);
    } catch {
      return null;
    }
  };

  let file = await safeFile(absolutePath);
  if (!file) {
    // Browser routes belong to the SPA; missing concrete assets stay 404.
    if (path.extname(requestedPath)) {
      return c.json({ error: "Asset not found." }, 404);
    }
    file = await safeFile(path.join(assetsRoot, "index.html"));
  }

  if (!file) {
    return c.json({ error: "Lightcode web entry is missing." }, 503);
  }

  if (path.basename(file.name ?? "") === "index.html") {
    c.header("Cache-Control", "no-store");
  } else {
    c.header("Cache-Control", "public, max-age=31536000, immutable");
  }
  if (file.type) {
    c.header("Content-Type", file.type);
  }
  return c.body(file.stream());
}

export const webRoutes = new Hono()
  .get("/app", (c) => {
    applyWebHeaders(c);
    c.header("Cache-Control", "no-store");
    return c.redirect("/app/", 307);
  })
  .get("/app/*", serveWebAsset);
