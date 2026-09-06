import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";
import { createNetworkFetch, isCertificateError } from "./network-fetch";

describe("network fetch", () => {
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), "lightcode-tls-"));
  });
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test("extends public trust roots and preserves caller headers and cancellation", async () => {
    const bundle = path.join(directory, "ca.pem");
    writeFileSync(bundle, rootCertificates[0]!);
    const caller = new AbortController();
    let received: BunFetchRequestInit | undefined;
    const wrapped = createNetworkFetch({
      env: { NODE_EXTRA_CA_CERTS: bundle },
      fetchImpl: (async (_input, init) => {
        received = init;
        return new Response("ok");
      }) as typeof fetch,
    });
    await wrapped("https://provider.test", {
      signal: caller.signal,
      headers: { "x-test": "value" },
    });
    expect(received?.tls?.rejectUnauthorized).toBe(true);
    expect((received?.tls?.ca as string[]).length).toBeGreaterThan(100);
    expect(received?.signal).toBe(caller.signal);
    expect(received?.headers).toEqual({ "x-test": "value" });
  });

  test("fails clearly on missing or invalid configured CA files before sending requests", async () => {
    let calls = 0;
    const invalid = path.join(directory, "invalid.pem");
    writeFileSync(invalid, "not a certificate");
    for (const file of [invalid, path.join(directory, "missing.pem")]) {
      const wrapped = createNetworkFetch({
        env: { LIGHTCODE_CA_CERTS: file },
        fetchImpl: (async () => {
          calls++;
          return new Response();
        }) as unknown as typeof fetch,
      });
      await expect(wrapped("https://provider.test")).rejects.toThrow(
        "Cannot load configured TLS CA",
      );
    }
    expect(calls).toBe(0);
  });

  test("bypasses proxies only for loopback and leaves remote proxy selection to Bun", async () => {
    const received: Array<BunFetchRequestInit | undefined> = [];
    const wrapped = createNetworkFetch({
      env: {},
      fetchImpl: (async (_input, init) => {
        received.push(init);
        return new Response();
      }) as typeof fetch,
    });
    for (const url of [
      "http://127.0.0.1:4983",
      "http://localhost:4983",
      "http://[::1]:4983",
      "https://provider.test",
    ])
      await wrapped(url);
    expect(received.map((init) => init?.proxy)).toEqual([
      "",
      "",
      "",
      undefined,
    ]);
  });

  test("recognizes nested certificate errors and tolerates circular causes", () => {
    const tlsError = Object.assign(new Error("handshake failed"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });
    expect(
      isCertificateError(new TypeError("fetch failed", { cause: tlsError })),
    ).toBe(true);
    const cycle = new Error("socket closed");
    cycle.cause = cycle;
    expect(isCertificateError(cycle)).toBe(false);
  });

  test.skipIf(!Bun.which("openssl"))(
    "verifies a real private-CA HTTPS connection and still rejects a hostname mismatch",
    async () => {
      const key = path.join(directory, "server-key.pem");
      const cert = path.join(directory, "server-cert.pem");
      const result = Bun.spawnSync(
        [
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          key,
          "-out",
          cert,
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode).toBe(0);
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        tls: { key: readFileSync(key), cert: readFileSync(cert) },
        fetch: () => new Response("trusted"),
      });
      try {
        const untrusted = createNetworkFetch({ env: {} });
        await expect(
          untrusted(`https://localhost:${server.port}`, { keepalive: false }),
        ).rejects.toThrow(/certificate/i);
        const trusted = createNetworkFetch({
          env: { LIGHTCODE_CA_CERTS: cert },
        });
        const response = await trusted(`https://localhost:${server.port}`, {
          keepalive: false,
        });
        expect(await response.text()).toBe("trusted");
        await expect(
          trusted(`https://127.0.0.1:${server.port}`, { keepalive: false }),
        ).rejects.toThrow(/certificate/i);
      } finally {
        server.stop(true);
      }
    },
  );
});
