import { describe, expect, test } from "bun:test";
import { webRoutes } from "./web-routes";

describe("web routes", () => {
  test("rejects traversal-shaped asset paths", async () => {
    const response = await webRoutes.request("/app/%2e%2e/package.json");
    expect([400, 404]).toContain(response.status);
  });

  test("sets browser hardening headers on the canonical app redirect", async () => {
    const response = await webRoutes.request("/app", { redirect: "manual" });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/app/");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });
});
