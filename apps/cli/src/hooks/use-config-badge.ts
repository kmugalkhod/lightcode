import { useEffect, useState } from "react";
import { client } from "../lib/client";
import { lightcodeConfigStatusSchema } from "@lightcode/ai";

export type ConfigBadgeState =
  | { status: "loading" }
  | {
      status: "available";
      provider: string;
      model: string;
      missingCredentialHints: string[];
    }
  | { status: "unavailable" };

export function useConfigBadge(refreshNonce = 0): ConfigBadgeState {
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

        const parsed = lightcodeConfigStatusSchema.safeParse(await response.json());
        if (!parsed.success) {
          if (!cancelled) setState({ status: "unavailable" });
          return;
        }

        if (!cancelled) {
          setState({
            status: "available",
            provider: parsed.data.selectedProvider,
            model: parsed.data.selectedModel,
            missingCredentialHints: parsed.data.missingCredentialHints,
          });
        }
      } catch {
        if (!cancelled) setState({ status: "unavailable" });
      }
    }

    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  return state;
}