import { timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

export const webAuthFileEnvironmentVariable = "LIGHTCODE_WEB_AUTH_FILE";

const webAuthHandoffSchema = z
  .object({
    version: z.literal(1),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    createdAt: z.string().datetime({ offset: true }).max(80),
  })
  .strict();

const maximumHandoffBytes = 4_096;
const maximumHandoffAgeMs = 5 * 60 * 1_000;
const maximumHandoffClockSkewMs = 30 * 1_000;

export interface WebAuthState {
  available: boolean;
  /** True when a web launch requested auth, even if its handoff was invalid. */
  configured?: boolean;
  token?: string;
  reason?: string;
}

export interface WebSecurityMiddlewareOptions {
  expectedOrigin?: string;
  authState?: WebAuthState;
  allowUnauthenticatedCli?: boolean;
}

function defaultExpectedOrigin(
  env: Record<string, string | undefined> = Bun.env,
): string {
  const configuredPort = env.PORT?.trim() || "4983";
  return new URL(`http://127.0.0.1:${configuredPort}`).origin;
}

function assertSecureHandoffMetadata(
  metadata: Stats,
): void {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("The web authentication handoff must be a regular file.");
  }
  if (metadata.size <= 0 || metadata.size > maximumHandoffBytes) {
    throw new Error("The web authentication handoff has an invalid size.");
  }

  if (process.platform !== "win32") {
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error(
        "The web authentication handoff must not be accessible by group or other users.",
      );
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error(
        "The web authentication handoff must be owned by the current user.",
      );
    }
  }
}

/**
 * Loads a per-launch browser token from a path-only environment handoff. The
 * token itself is never placed in the process environment, where agent-run
 * subprocesses would inherit it. The file is unlinked immediately after a
 * successful, inode-stable read.
 */
export function loadWebAuthTokenFromHandoffFile(filePath: string): string {
  if (!path.isAbsolute(filePath)) {
    throw new Error("The web authentication handoff path must be absolute.");
  }

  const beforeOpen = lstatSync(filePath);
  assertSecureHandoffMetadata(beforeOpen);

  const noFollowFlag =
    typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(filePath, constants.O_RDONLY | noFollowFlag);
  let raw: string;
  try {
    const opened = fstatSync(descriptor);
    assertSecureHandoffMetadata(opened);
    if (opened.dev !== beforeOpen.dev || opened.ino !== beforeOpen.ino) {
      throw new Error("The web authentication handoff changed while opening.");
    }
    raw = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("The web authentication handoff payload is invalid.");
  }
  const parsed = webAuthHandoffSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("The web authentication handoff payload is invalid.");
  }
  const createdAtMs = Date.parse(parsed.data.createdAt);
  const ageMs = Date.now() - createdAtMs;
  if (ageMs > maximumHandoffAgeMs || ageMs < -maximumHandoffClockSkewMs) {
    throw new Error("The web authentication handoff has expired.");
  }

  const beforeUnlink = lstatSync(filePath);
  if (
    beforeUnlink.dev !== beforeOpen.dev ||
    beforeUnlink.ino !== beforeOpen.ino
  ) {
    throw new Error("The web authentication handoff changed before cleanup.");
  }
  unlinkSync(filePath);

  return parsed.data.token;
}

export function loadWebAuthStateFromEnvironment(
  env: Record<string, string | undefined> = Bun.env,
): WebAuthState {
  const filePath = env[webAuthFileEnvironmentVariable]?.trim();
  if (!filePath) {
    return {
      available: false,
      configured: false,
      reason: `${webAuthFileEnvironmentVariable} is not configured.`,
    };
  }

  try {
    return {
      available: true,
      configured: true,
      token: loadWebAuthTokenFromHandoffFile(filePath),
    };
  } catch (error) {
    return {
      available: false,
      configured: true,
      reason:
        error instanceof Error
          ? error.message
          : "Unable to load the web authentication handoff.",
    };
  }
}

function isPublicWebPath(pathname: string): boolean {
  return (
    pathname === "/healthz" ||
    pathname === "/app" ||
    pathname === "/app/" ||
    pathname.startsWith("/app/")
  );
}

function isPublicWebAppPath(pathname: string): boolean {
  return pathname === "/app" || pathname === "/app/" || pathname.startsWith("/app/");
}

function looksLikeBrowserRequest(request: Request): boolean {
  const headers = request.headers;
  if (headers.get("x-lightcode-client")?.toLowerCase() === "web") {
    return true;
  }
  if (
    headers.has("origin") ||
    headers.has("sec-fetch-site") ||
    headers.has("sec-fetch-mode") ||
    headers.has("sec-fetch-dest")
  ) {
    return true;
  }

  const userAgent = headers.get("user-agent") ?? "";
  return /(?:Mozilla\/|Chrom(?:e|ium)\/|Safari\/)/i.test(userAgent);
}

function hasValidBearerToken(request: Request, expectedToken: string): boolean {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  if (!match) {
    return false;
  }

  const actual = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function setBrowserSecurityHeaders(
  setHeader: (name: string, value: string) => void,
): void {
  setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  setHeader("Cross-Origin-Opener-Policy", "same-origin");
  setHeader("Cross-Origin-Resource-Policy", "same-origin");
  setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  setHeader("Referrer-Policy", "no-referrer");
  setHeader("X-Content-Type-Options", "nosniff");
  setHeader("X-Frame-Options", "DENY");
}

function jsonSecurityError(
  c: Parameters<MiddlewareHandler>[0],
  status: 401 | 403 | 503,
  code: string,
  error: string,
) {
  c.header("Cache-Control", "no-store");
  if (status === 401) {
    c.header("WWW-Authenticate", 'Bearer realm="lightcode-web"');
  }
  return c.json({ error, code }, status);
}

const defaultAuthState = loadWebAuthStateFromEnvironment();

/**
 * Secures requests that originate in a browser while preserving the existing
 * headerless loopback CLI protocol. Fetch Metadata headers are controlled by
 * the browser, so a hostile website cannot opt into the CLI compatibility
 * path or hide a DNS-rebinding Host value.
 */
export function createWebSecurityMiddleware(
  options: WebSecurityMiddlewareOptions = {},
): MiddlewareHandler {
  const expectedOrigin = new URL(
    options.expectedOrigin ?? defaultExpectedOrigin(),
  ).origin;
  const expectedHost = new URL(expectedOrigin).host;
  const authState = options.authState ?? defaultAuthState;
  const allowUnauthenticatedCli =
    options.allowUnauthenticatedCli ??
    (Bun.env.LIGHTCODE_HOST?.trim() || "127.0.0.1") === "127.0.0.1";

  return async (c, next) => {
    const request = c.req.raw;
    const browserRequest = looksLikeBrowserRequest(request);
    const pathname = new URL(request.url).pathname;
    const publicPath = isPublicWebPath(pathname);
    if (!publicPath) {
      c.header("Cache-Control", "no-store");
    }
    const requestHost = request.headers.get("host") ?? new URL(request.url).host;
    // A tokenized `lightcode web` server authenticates every API client, not
    // only requests that look browser-like. Loopback TCP is shared by all OS
    // users, and curl can trivially omit Fetch Metadata headers.
    if (
      (browserRequest || authState.available || authState.configured) &&
      requestHost !== expectedHost
    ) {
      return jsonSecurityError(
        c,
        403,
        "web_host_forbidden",
        "Browser requests must use the Lightcode loopback origin.",
      );
    }

    if (browserRequest) {
      setBrowserSecurityHeaders((name, value) => c.header(name, value));
    }

    const origin = request.headers.get("origin");
    if (browserRequest && origin !== null && origin !== expectedOrigin) {
      return jsonSecurityError(
        c,
        403,
        "web_origin_forbidden",
        "The browser origin is not allowed.",
      );
    }

    const fetchSite = request.headers.get("sec-fetch-site");
    const isBootstrapDocumentNavigation =
      isPublicWebAppPath(pathname) &&
      (request.method === "GET" || request.method === "HEAD") &&
      request.headers.get("sec-fetch-mode") === "navigate" &&
      request.headers.get("sec-fetch-dest") === "document";
    const allowedFetchSites = publicPath
      ? new Set(["same-origin", "none"])
      : new Set(["same-origin"]);
    if (
      browserRequest &&
      fetchSite !== null &&
      !allowedFetchSites.has(fetchSite) &&
      !(fetchSite === "cross-site" && isBootstrapDocumentNavigation)
    ) {
      return jsonSecurityError(
        c,
        403,
        "web_fetch_forbidden",
        "Cross-site browser requests are not allowed.",
      );
    }

    if (!publicPath && browserRequest) {
      const safeMethod = request.method === "GET" || request.method === "HEAD";
      if (!safeMethod && origin !== expectedOrigin) {
        return jsonSecurityError(
          c,
          403,
          "web_origin_required",
          "State-changing browser requests require the exact Lightcode origin.",
        );
      }

      const contentType = request.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (
        !safeMethod &&
        request.method !== "OPTIONS" &&
        contentType !== "application/json"
      ) {
        return c.json(
          {
            error: "State-changing browser requests must use application/json.",
            code: "web_json_required",
          },
          415,
        );
      }
    }

    if (!publicPath) {
      if (authState.available && authState.token) {
        if (!hasValidBearerToken(request, authState.token)) {
          return jsonSecurityError(
            c,
            401,
            "web_auth_required",
            "A valid Lightcode browser token is required.",
          );
        }
      } else if (browserRequest || authState.configured) {
        return jsonSecurityError(
          c,
          503,
          "web_auth_unavailable",
          "Browser access is unavailable. Start Lightcode with `lightcode web`.",
        );
      } else if (!allowUnauthenticatedCli) {
        return jsonSecurityError(
          c,
          503,
          "web_auth_unavailable",
          "Unauthenticated API access is disabled for a non-loopback server binding.",
        );
      }

      // Browser clients must enter through an opaque workspace grant. The
      // legacy raw-cwd endpoint remains available only on the non-web CLI
      // server for one compatibility release.
      if (browserRequest && request.method === "POST" && pathname === "/sessions") {
        return jsonSecurityError(
          c,
          403,
          "workspace_grant_required",
          "Browser sessions must be created from a selected workspace grant.",
        );
      }
    }

    await next();
  };
}
