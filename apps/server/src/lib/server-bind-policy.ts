import { isIP } from "node:net";

/** Local agent APIs are never exposed on LAN/WAN interfaces. */
export function isLoopbackBindHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (isIP(normalized) === 4) {
    return normalized.split(".", 1)[0] === "127";
  }
  return isIP(normalized) === 6 && normalized === "::1";
}
