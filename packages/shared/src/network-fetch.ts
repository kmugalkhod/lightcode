import { readFileSync, statSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import * as tls from "node:tls";

const certificatePattern =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const certificateErrorPattern =
  /CERT_(?:HAS_EXPIRED|NOT_YET_VALID|REVOKED|UNTRUSTED|SIGNATURE_FAILURE)|CERTIFICATE_VERIFY_FAILED|UNABLE_TO_(?:GET_ISSUER_CERT(?:_LOCALLY)?|VERIFY_LEAF_SIGNATURE)|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|ERR_TLS_CERT_ALTNAME_INVALID|certificate|self.signed|unable to (?:get local issuer|verify the first)/i;

/** Inspect SDK/network cause chains without losing the underlying TLS failure. */
export function isCertificateError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (
    current &&
    typeof current === "object" &&
    !seen.has(current) &&
    seen.size < 12
  ) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (
      certificateErrorPattern.test(
        `${record.code ?? ""} ${record.message ?? ""}`,
      )
    )
      return true;
    current = record.cause;
  }
  return false;
}

export const certificateErrorHint =
  "TLS certificate verification failed. Configure your company CA PEM with NODE_EXTRA_CA_CERTS or LIGHTCODE_CA_CERTS, then restart Lightcode. If a CA is already configured, check the server certificate hostname, expiry, and chain.";

/** Server-only transport shared by providers, catalogs, diagnostics and web tools. */
export function createNetworkFetch({
  env = process.env,
  fetchImpl,
}: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
} = {}): typeof fetch {
  let cachedKey = "";
  let cachedCa: string[] | undefined;
  let checkedAt = 0;

  const resolveCa = () => {
    const paths = [
      ...new Set(
        [env.LIGHTCODE_CA_CERTS, env.NODE_EXTRA_CA_CERTS, env.SSL_CERT_FILE]
          .map((value) => value?.trim())
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    const key = JSON.stringify(paths);
    if (key === cachedKey && Date.now() - checkedAt < 30_000) return cachedCa;
    const extra: string[] = [];
    for (const file of paths) {
      try {
        if (statSync(file).size > 4 * 1024 * 1024)
          throw new Error("CA bundle exceeds 4 MiB");
        const certificates = readFileSync(file, "utf8").match(
          certificatePattern,
        );
        if (!certificates?.length) throw new Error("No PEM certificates found");
        for (const cert of certificates) new X509Certificate(cert);
        extra.push(...certificates);
      } catch (cause) {
        throw new Error(
          "Cannot load configured TLS CA certificate bundle. Check LIGHTCODE_CA_CERTS, NODE_EXTRA_CA_CERTS and SSL_CERT_FILE for readable PEM files.",
          { cause },
        );
      }
    }
    // Some Bun versions return no system CAs; preserve the bundled public roots.
    let defaults = [...tls.rootCertificates];
    try {
      defaults.push(
        ...tls.getCACertificates("default"),
        ...tls.getCACertificates("system"),
      );
    } catch {
      /* Older runtimes still support explicit CA bundles. */
    }
    cachedCa = extra.length ? [...new Set([...defaults, ...extra])] : undefined;
    cachedKey = key;
    checkedAt = Date.now();
    return cachedCa;
  };

  return (async (
    input: Parameters<typeof fetch>[0],
    init?: BunFetchRequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const ca = url.protocol === "https:" ? resolveCa() : undefined;
    // Bun handles HTTPS_PROXY / HTTP_PROXY / NO_PROXY. The companion server
    // always stays local even when a company proxy is configured globally.
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    try {
      return await (fetchImpl ?? globalThis.fetch)(input, {
        ...init,
        ...(local && init?.proxy === undefined ? { proxy: "" } : {}),
        ...(ca
          ? {
              tls: {
                ...init?.tls,
                ca: init?.tls?.ca ?? ca,
                rejectUnauthorized: true,
              },
            }
          : {}),
      });
    } catch (cause) {
      if (isCertificateError(cause))
        throw new Error(certificateErrorHint, { cause });
      throw cause;
    }
  }) as typeof fetch;
}

export const networkFetch = createNetworkFetch();
