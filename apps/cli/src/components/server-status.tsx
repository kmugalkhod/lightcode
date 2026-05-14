import { useEffect, useState } from "react";
import { client } from "../lib/client";

type ServerStatus = "checking" | "online" | "unhealthy" | "offline";

export function ServerStatus() {
  const [status, setStatus] = useState<ServerStatus>("checking");

  useEffect(() => {
    let cancelled = false;

    async function checkServer() {
      try {
        const response = await client.health.$get();
        const data = await response.json();

        if (!cancelled) {
          setStatus(response.ok && data.ok ? "online" : "unhealthy");
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

  const colorByStatus: Record<ServerStatus, string> = {
    checking: "#94A3B8",
    online: "#22C55E",
    unhealthy: "#F59E0B",
    offline: "#EF4444",
  };

  return (
    <text fg={colorByStatus[status]}>
      Server: {status}
    </text>
  );
}
