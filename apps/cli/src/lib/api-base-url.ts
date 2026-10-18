// 127.0.0.1 (not localhost) and an uncommon port: the server binds loopback
// IPv4 only, while "localhost" can resolve to ::1 — which lets any user dev
// server bound to [::] (e.g. Next.js on 3000) intercept CLI traffic.
const configuredApiUrl = Bun.env.LIGHTCODE_API_URL?.trim() || null;

/** LIGHTCODE_API_URL pins the address; Lightcode then never moves the server. */
export const apiUrlPinned = configuredApiUrl !== null;

/**
 * Where the CLI reaches its server. The launcher moves it to a nearby port
 * when the default one is taken; it does so before the UI (and the client
 * built from this value) loads.
 */
export let apiBaseUrl = configuredApiUrl ?? "http://127.0.0.1:4983";

export function setApiBaseUrl(url: string): void {
  apiBaseUrl = url;
}
