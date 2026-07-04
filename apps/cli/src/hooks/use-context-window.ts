import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  lightcodeConfigStatusSchema,
  type LightcodeConfigStatus,
} from "@lightcode/ai";
import { useEffect, useState } from "react";
import { client } from "../lib/client";

interface ModelBudgetInfo {
  contextWindow: number;
  pricing: LightcodeConfigStatus["pricing"];
}

/**
 * Context window and per-token pricing of the active model, fetched from the
 * server config status. Falls back to a conservative window and unknown
 * pricing while loading or when the server is unreachable.
 */
export function useModelBudgetInfo(): ModelBudgetInfo {
  const [info, setInfo] = useState<ModelBudgetInfo>({
    contextWindow: DEFAULT_CONTEXT_WINDOW_TOKENS,
    pricing: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function loadModelBudgetInfo() {
      try {
        const response = await client.config.status.$get();
        if (!response.ok) {
          return;
        }

        const parsed = lightcodeConfigStatusSchema.safeParse(
          await response.json(),
        );
        if (!cancelled && parsed.success) {
          setInfo({
            contextWindow: parsed.data.contextWindow,
            pricing: parsed.data.pricing,
          });
        }
      } catch {
        // Keep the defaults; the meter stays approximately right.
      }
    }

    void loadModelBudgetInfo();
    return () => {
      cancelled = true;
    };
  }, []);

  return info;
}

/** Effective context window of the active model in tokens. */
export function useContextWindow(): number {
  return useModelBudgetInfo().contextWindow;
}
