import { useEffect, useState } from "react";
import { serverStatusColors } from "../ui/cli-theme";

type ServerStatus = "checking" | "online" | "unhealthy" | "offline";
const apiBaseUrl = Bun.env.NIGHTCODE_API_URL ?? "http://localhost:3000";

export function ServerStatus() {
  const [status, setStatus] = useState<ServerStatus>("checking");

  useEffect(() => {
    let cancelled = false;

    async function checkServer() {
      try {
        if (!cancelled) {
          const response = await fetch(apiBaseUrl);
          setStatus(response.ok ? "online" : "unhealthy");
        }
      } catch {
        if (!cancelled) {
          setStatus("offline");
        }
      }
    }

    checkServer();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <text fg={serverStatusColors[status]}>
      Server: {status}
    </text>
  );
}
