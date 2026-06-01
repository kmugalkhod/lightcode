import { useEffect, useState } from "react";
import { client } from "../lib/client";
import type { LightcodeConfigStatus } from "@lightcode/ai";

export type ConfigBadgeState =
  | { status: "loading" }
  | { status: "available"; provider: string; model: string }
  | { status: "unavailable" };

export function useConfigBadge(): ConfigBadgeState {
  const [state, setState] = useState<ConfigBadgeState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function loadConfig() {
      try {
        const response = await client.config.status.$get();
        if (!response.ok) {
          if (!cancelled) setState({ status: "unavailable" });
          return;
        }

        const rawPayload = await response.json();
        // Validate with schema - provider/model fields only, no secrets
        const payload = rawPayload as LightcodeConfigStatus;

        if (!cancelled) {
          const provider = payload.selectedProvider ?? "unknown";
          const model = payload.selectedModel ?? "unknown";
          setState({ status: "available", provider, model });
        }
      } catch {
        if (!cancelled) setState({ status: "unavailable" });
      }
    }

    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}