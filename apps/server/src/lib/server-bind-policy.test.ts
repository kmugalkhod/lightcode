import { describe, expect, test } from "bun:test";
import { isLoopbackBindHost } from "./server-bind-policy";

describe("isLoopbackBindHost", () => {
  test("accepts IPv4 and IPv6 loopback addresses", () => {
    expect(isLoopbackBindHost("127.0.0.1")).toBe(true);
    expect(isLoopbackBindHost("127.42.0.8")).toBe(true);
    expect(isLoopbackBindHost("::1")).toBe(true);
  });

  test("rejects wildcard, LAN, hostname, and malformed bindings", () => {
    for (const hostname of ["0.0.0.0", "::", "192.168.1.10", "localhost", "bad-host"]) {
      expect(isLoopbackBindHost(hostname)).toBe(false);
    }
  });
});
