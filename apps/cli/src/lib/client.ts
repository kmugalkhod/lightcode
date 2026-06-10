import { hc } from "hono/client";
import type { AppType } from "@lightcode/server/rpc";
import { apiBaseUrl } from "./api-base-url";

export const client = hc<AppType>(apiBaseUrl);
