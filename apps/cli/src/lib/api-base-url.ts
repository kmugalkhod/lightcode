export const apiBaseUrl =
  Bun.env.LIGHTCODE_API_URL ??
  Bun.env.NIGHTCODE_API_URL ??
  "http://localhost:3000";
