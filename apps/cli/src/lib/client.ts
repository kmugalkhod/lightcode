import { hc } from "hono/client";
import type { AppType } from "@lightcode/server/rpc";

const baseUrl = Bun.env.LIGHTCODE_API_URL ?? "http://localhost:3000";

export const client = hc<AppType>(baseUrl);
