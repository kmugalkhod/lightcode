import { createLogger, getErrorMessage } from "@lightcode/shared";
import { disableHeadroomRouting, lightcodeConfigResult } from "./runtime-config";

const logger = createLogger("headroom-proxy");

const healthCheckTimeoutMs = 1_500;

export type HeadroomHealth = "healthy" | "down";

/**
 * Liveness probe for the headroom compressing proxy. Any HTTP response means
 * something is listening and able to route, so only a connection error or
 * timeout counts as "down" — we cannot assume a specific status path exists on
 * an arbitrary proxy build. Mirrors the tolerant health check the CLI server
 * launcher uses (server-launcher.ts `checkServer`).
 */
export async function checkHeadroomHealth(
  proxyUrl: string,
): Promise<HeadroomHealth> {
  try {
    await fetch(new URL("/health", proxyUrl), {
      signal: AbortSignal.timeout(healthCheckTimeoutMs),
    });
    return "healthy";
  } catch {
    return "down";
  }
}

/**
 * Startup gate for the headroom facility. When routing is enabled, probes the
 * proxy once: if it is unreachable and `failOpen` is set (the default), it
 * disables routing so the agent talks straight to the real provider — a dead
 * Python/ML sidecar must never break a coding session. Fire-and-forget from the
 * server bootstrap; never throws and never blocks a chat request.
 */
export async function ensureHeadroomRouting(): Promise<void> {
  const headroom = lightcodeConfigResult.config.headroom;
  if (!headroom?.enabled) {
    return;
  }

  let health: HeadroomHealth;
  try {
    health = await checkHeadroomHealth(headroom.proxyUrl);
  } catch (error) {
    // checkHeadroomHealth swallows its own errors, but stay defensive.
    health = "down";
    logger.warn("headroom_health_probe_failed", {
      proxyUrl: headroom.proxyUrl,
      error: getErrorMessage(error),
    });
  }

  if (health === "healthy") {
    logger.info("headroom_routing_active", { proxyUrl: headroom.proxyUrl });
    return;
  }

  if (headroom.failOpen) {
    logger.warn("headroom_unreachable_failing_open", {
      proxyUrl: headroom.proxyUrl,
    });
    disableHeadroomRouting();
    return;
  }

  // failOpen disabled: the user explicitly wants compression enforced. Leave
  // routing on and surface the problem loudly rather than silently degrading.
  logger.error("headroom_unreachable_fail_closed", {
    proxyUrl: headroom.proxyUrl,
  });
}
