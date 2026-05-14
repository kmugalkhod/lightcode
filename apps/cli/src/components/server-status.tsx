import { useEffect, useState } from "react";
type ServerStatus = "checking" | "online" | "unhealthy" | "offline";
const apiBaseUrl = Bun.env.LIGHTCODE_API_URL ?? "http://localhost:3000";

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
