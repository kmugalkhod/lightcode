import {
  defaultAutoContinueConfig,
  lightcodeConfigStatusSchema,
  type ResolvedAutoContinueConfig,
} from "@lightcode/ai";
import { useEffect, useState } from "react";
import { client } from "../lib/client";

/**
 * Auto-continue limits from the server config status. Falls back to the
 * built-in defaults while loading or when the server is unreachable.
 */
export function useAutoContinueConfig(): ResolvedAutoContinueConfig {
  const [config, setConfig] = useState<ResolvedAutoContinueConfig>(
    defaultAutoContinueConfig,
  );

  useEffect(() => {
    let cancelled = false;

    async function loadConfig() {
      try {
        const response = await client.config.status.$get();
        if (!response.ok) {
          return;
        }

        const parsed = lightcodeConfigStatusSchema.safeParse(
          await response.json(),
        );
        if (!cancelled && parsed.success) {
          setConfig(parsed.data.autoContinue);
        }
      } catch {
        // Keep the defaults; continuation still works.
      }
    }

    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}
