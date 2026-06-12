// 127.0.0.1 (not localhost) and an uncommon port: the server binds loopback
// IPv4 only, while "localhost" can resolve to ::1 — which lets any user dev
// server bound to [::] (e.g. Next.js on 3000) intercept CLI traffic.
export const apiBaseUrl =
  Bun.env.LIGHTCODE_API_URL ?? "http://127.0.0.1:4983";
