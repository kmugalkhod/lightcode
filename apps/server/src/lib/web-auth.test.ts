import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import {
  createWebSecurityMiddleware,
  loadWebAuthStateFromEnvironment,
  loadWebAuthTokenFromHandoffFile,
} from "./web-auth";

const expectedOrigin = "http://127.0.0.1:4983";
const token = Buffer.alloc(32, 7).toString("base64url");
const temporaryDirectories: string[] = [];

function createTestApp() {
  return new Hono()
    .use(
      "*",
      createWebSecurityMiddleware({
        expectedOrigin,
        authState: { available: true, token },
      }),
    )
    .get("/healthz", (c) => c.json({ ok: true }))
    .get("/app", (c) => c.html("app"))
    .get("/private", (c) => c.json({ private: true }))
    .post("/sessions", (c) => c.json({ created: true }))
    .post("/mutate", (c) => c.json({ mutated: true }));
}

function browserHeaders(overrides: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${token}`,
    host: "127.0.0.1:4983",
    origin: expectedOrigin,
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("web security middleware", () => {
  test("keeps headerless local CLI requests compatible", async () => {
    const app = new Hono()
      .use(
        "*",
        createWebSecurityMiddleware({
          expectedOrigin,
          authState: { available: false },
        }),
      )
      .get("/private", (c) => c.json({ private: true }));
    const response = await app.request("http://cli.invalid/private");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ private: true });
  });

  test("fails closed for headerless clients when the server is not loopback-only", async () => {
    const app = new Hono()
      .use(
        "*",
        createWebSecurityMiddleware({
          expectedOrigin,
          authState: { available: false },
          allowUnauthenticatedCli: false,
        }),
      )
      .get("/private", (c) => c.json({ private: true }));
    const response = await app.request("http://network-host.invalid/private");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "web_auth_unavailable",
    });
  });

  test("fails closed for every client when a configured handoff could not load", async () => {
    const app = new Hono()
      .use(
        "*",
        createWebSecurityMiddleware({
          expectedOrigin,
          authState: {
            available: false,
            configured: true,
            reason: "invalid handoff",
          },
        }),
      )
      .get("/private", (c) => c.json({ private: true }));
    const response = await app.request(`${expectedOrigin}/private`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "web_auth_unavailable",
    });
  });

  test("requires bearer auth even without browser headers on a web server", async () => {
    const app = createTestApp();
    const missing = await app.request(`${expectedOrigin}/private`);
    expect(missing.status).toBe(401);

    const accepted = await app.request(`${expectedOrigin}/private`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(accepted.status).toBe(200);
  });

  test("requires a bearer token for browser API requests", async () => {
    const app = createTestApp();
    const missing = await app.request(`${expectedOrigin}/private`, {
      headers: browserHeaders({ authorization: "" }),
    });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ code: "web_auth_required" });

    const accepted = await app.request(`${expectedOrigin}/private`, {
      headers: browserHeaders(),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    expect(accepted.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  test("rejects DNS-rebinding hosts, foreign origins, and cross-site fetches", async () => {
    const app = createTestApp();
    const badHost = await app.request(`${expectedOrigin}/private`, {
      headers: browserHeaders({ host: "attacker.example" }),
    });
    expect(badHost.status).toBe(403);
    expect(await badHost.json()).toMatchObject({ code: "web_host_forbidden" });

    const badOrigin = await app.request(`${expectedOrigin}/private`, {
      headers: browserHeaders({ origin: "https://attacker.example" }),
    });
    expect(badOrigin.status).toBe(403);
    expect(await badOrigin.json()).toMatchObject({ code: "web_origin_forbidden" });

    const crossSite = await app.request(`${expectedOrigin}/private`, {
      headers: browserHeaders({ "sec-fetch-site": "cross-site" }),
    });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toMatchObject({ code: "web_fetch_forbidden" });
  });

  test("requires exact Origin and rejects form content for browser mutations", async () => {
    const app = createTestApp();
    const { origin: _ignoredOrigin, ...noOriginHeaders } = browserHeaders();
    const noOrigin = await app.request(`${expectedOrigin}/mutate`, {
      method: "POST",
      headers: noOriginHeaders,
    });
    expect(noOrigin.status).toBe(403);
    expect(await noOrigin.json()).toMatchObject({ code: "web_origin_required" });

    const nullOrigin = await app.request(`${expectedOrigin}/mutate`, {
      method: "POST",
      headers: browserHeaders({ origin: "null" }),
    });
    expect(nullOrigin.status).toBe(403);

    const form = await app.request(`${expectedOrigin}/mutate`, {
      method: "POST",
      headers: browserHeaders({
        "content-type": "application/x-www-form-urlencoded",
      }),
      body: "value=1",
    });
    expect(form.status).toBe(415);
    expect(await form.json()).toMatchObject({ code: "web_json_required" });

    const missing = await app.request(`${expectedOrigin}/mutate`, {
      method: "POST",
      headers: browserHeaders(),
    });
    expect(missing.status).toBe(415);

    const caseInsensitiveJson = await app.request(`${expectedOrigin}/mutate`, {
      method: "POST",
      headers: browserHeaders({
        "content-type": "Application/JSON; Charset=UTF-8",
      }),
      body: "{}",
    });
    expect(caseInsensitiveJson.status).toBe(200);
  });

  test("allows token-free static navigation only on the exact loopback host", async () => {
    const app = createTestApp();
    const { origin: _ignoredOrigin, ...navigationHeaders } = browserHeaders({
      authorization: "",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
    });
    const accepted = await app.request(`${expectedOrigin}/app`, {
      headers: navigationHeaders,
    });
    expect(accepted.status).toBe(200);

    const rejected = await app.request(`${expectedOrigin}/app`, {
      headers: {
        ...navigationHeaders,
        host: "rebinding.example",
      },
    });
    expect(rejected.status).toBe(403);
  });

  test("allows the private file bootstrap to navigate only to the public app document", async () => {
    const app = createTestApp();
    const bootstrapHeaders = {
      host: "127.0.0.1:4983",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "cross-site",
      "user-agent": "Mozilla/5.0",
    };

    const appDocument = await app.request(`${expectedOrigin}/app`, {
      headers: bootstrapHeaders,
    });
    expect(appDocument.status).toBe(200);

    const appHead = await app.request(`${expectedOrigin}/app`, {
      method: "HEAD",
      headers: bootstrapHeaders,
    });
    expect(appHead.status).toBe(200);

    const privateApi = await app.request(`${expectedOrigin}/private`, {
      headers: bootstrapHeaders,
    });
    expect(privateApi.status).toBe(403);
    expect(await privateApi.json()).toMatchObject({ code: "web_fetch_forbidden" });

    const crossSiteAssetFetch = await app.request(`${expectedOrigin}/app/index.js`, {
      headers: {
        ...bootstrapHeaders,
        "sec-fetch-dest": "script",
        "sec-fetch-mode": "no-cors",
      },
    });
    expect(crossSiteAssetFetch.status).toBe(403);

    const framedNavigation = await app.request(`${expectedOrigin}/app`, {
      headers: { ...bootstrapHeaders, "sec-fetch-dest": "iframe" },
    });
    expect(framedNavigation.status).toBe(403);

    const incompleteNavigation = await app.request(`${expectedOrigin}/app`, {
      headers: { ...bootstrapHeaders, "sec-fetch-dest": "" },
    });
    expect(incompleteNavigation.status).toBe(403);

    const sameSiteNavigation = await app.request(`${expectedOrigin}/app`, {
      headers: { ...bootstrapHeaders, "sec-fetch-site": "same-site" },
    });
    expect(sameSiteNavigation.status).toBe(403);

    const nullOriginNavigation = await app.request(`${expectedOrigin}/app`, {
      headers: { ...bootstrapHeaders, origin: "null" },
    });
    expect(nullOriginNavigation.status).toBe(403);
    expect(await nullOriginNavigation.json()).toMatchObject({
      code: "web_origin_forbidden",
    });

    const crossSiteMutation = await app.request(`${expectedOrigin}/app`, {
      method: "POST",
      headers: bootstrapHeaders,
    });
    expect(crossSiteMutation.status).toBe(403);
  });

  test("fails closed when browser authentication was not provisioned", async () => {
    const app = new Hono()
      .use(
        "*",
        createWebSecurityMiddleware({
          expectedOrigin,
          authState: { available: false },
        }),
      )
      .get("/private", (c) => c.json({ private: true }));

    const response = await app.request(`${expectedOrigin}/private`, {
      headers: browserHeaders(),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "web_auth_unavailable" });
  });

  test("browser callers cannot bypass grants through legacy session creation", async () => {
    const response = await createTestApp().request(`${expectedOrigin}/sessions`, {
      method: "POST",
      headers: browserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ cwd: "/" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "workspace_grant_required",
    });
  });
});

describe("web authentication handoff", () => {
  async function makeHandoff(
    mode = 0o600,
    payload: unknown = {
      version: 1,
      token,
      createdAt: new Date().toISOString(),
    },
  ) {
    const directory = await mkdtemp(path.join(tmpdir(), "lightcode-web-auth-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "handoff.json");
    await writeFile(
      filePath,
      JSON.stringify(payload),
      { mode },
    );
    await chmod(filePath, mode);
    return filePath;
  }

  test("loads a 0600 token file and unlinks it", async () => {
    const filePath = await makeHandoff();
    expect(loadWebAuthTokenFromHandoffFile(filePath)).toBe(token);
    expect(await lstat(filePath).catch(() => null)).toBeNull();
  });

  test("loads from a path-only environment contract", async () => {
    const filePath = await makeHandoff();
    const state = loadWebAuthStateFromEnvironment({
      LIGHTCODE_WEB_AUTH_FILE: filePath,
    });
    expect(state).toEqual({ available: true, configured: true, token });
  });

  test.skipIf(process.platform === "win32")(
    "rejects a group-readable token file",
    async () => {
      const filePath = await makeHandoff(0o640);
      expect(() => loadWebAuthTokenFromHandoffFile(filePath)).toThrow(
        /group or other users/,
      );
    },
  );

  test("rejects a symbolic-link handoff", async () => {
    const target = await makeHandoff();
    const linkedPath = path.join(path.dirname(target), "linked.json");
    await symlink(target, linkedPath);
    expect(() => loadWebAuthTokenFromHandoffFile(linkedPath)).toThrow(
      /regular file/,
    );
  });

  test("rejects stale, malformed, and oversized handoffs", async () => {
    const stale = await makeHandoff(0o600, {
      version: 1,
      token,
      createdAt: new Date(Date.now() - 10 * 60 * 1_000).toISOString(),
    });
    expect(() => loadWebAuthTokenFromHandoffFile(stale)).toThrow(/expired/);

    const malformed = await makeHandoff(0o600, { version: 1, token });
    expect(() => loadWebAuthTokenFromHandoffFile(malformed)).toThrow(
      /payload is invalid/,
    );

    const oversized = await makeHandoff(0o600, "x".repeat(5_000));
    expect(() => loadWebAuthTokenFromHandoffFile(oversized)).toThrow(
      /invalid size/,
    );
  });
});
