import { describe, expect, test } from "bun:test";
import type { ResolvedWebSearchCapability } from "@lightcode/ai";
import { createWebSearchDiagnosticCheck } from "./diagnostics-routes";

const limits = {
  maxResults: 3,
  maxTotalResults: 6,
  maxUsesPerTurn: 3,
  maxCharactersPerResult: 1200,
  timeoutMs: 20000,
} as const;

describe("web-search diagnostics", () => {
  test("reports the resolved backend, execution mode, and limits", () => {
    const capability: ResolvedWebSearchCapability = {
      available: true,
      backend: "openrouter",
      execution: "provider",
      limits,
      reason: null,
    };

    expect(createWebSearchDiagnosticCheck(capability)).toEqual({
      id: "web-search",
      label: "Web Search",
      status: "ok",
      summary: "Web search is ready through openrouter (provider).",
      details: [
        "Limits: 3 uses, 3 results/search, 6 results total, 1200 chars/result.",
      ],
    });
  });

  test("surfaces an exact setup reason when search is unavailable", () => {
    const reason = "Configure BRAVE_SEARCH_API_KEY to enable web search.";
    const capability: ResolvedWebSearchCapability = {
      available: false,
      backend: "brave",
      execution: "none",
      limits,
      reason,
    };
    const check = createWebSearchDiagnosticCheck(capability);

    expect(check.status).toBe("warn");
    expect(check.summary).toBe("Web search is unavailable.");
    expect(check.details[0]).toBe(reason);
  });
});
