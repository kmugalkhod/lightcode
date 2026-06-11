import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  lightcodeConfigStatusSchema,
} from "@lightcode/ai";
import { useEffect, useState } from "react";
import { client } from "../lib/client";

/**
 * Effective context window of the active model in tokens, fetched from the
 * server config status. Falls back to a conservative default while loading
 * or when the server is unreachable.
 */
export function useContextWindow(): number {
  const [contextWindow, setContextWindow] = useState(
    DEFAULT_CONTEXT_WINDOW_TOKENS,
  );

  useEffect(() => {
    let cancelled = false;

    async function loadContextWindow() {
      try {
        const response = await client.config.status.$get();
        if (!response.ok) {
          return;
        }

        const parsed = lightcodeConfigStatusSchema.safeParse(
          await response.json(),
        );
        if (!cancelled && parsed.success) {
          setContextWindow(parsed.data.contextWindow);
        }
      } catch {
        // Keep the default; the meter stays approximately right.
      }
    }

    void loadContextWindow();
    return () => {
      cancelled = true;
    };
  }, []);

  return contextWindow;
}
