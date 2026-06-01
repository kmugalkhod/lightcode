import { z } from "zod";
import {
  webSearchInputSchema,
  webSearchOutputSchema,
  type webSearchProviderSchema,
} from "./schema";

type WebSearchInput = z.input<typeof webSearchInputSchema>;
type WebSearchOutput = z.infer<typeof webSearchOutputSchema>;
type WebSearchProvider = z.infer<typeof webSearchProviderSchema>;
type WebSearchResult = WebSearchOutput["results"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function getStringProperty(record: Record<string, unknown>, key: string) {
  return getString(record[key]);
}

function getArrayProperty(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function configuredProvider(requestedProvider: WebSearchProvider) {
  if (requestedProvider !== "auto") {
    return requestedProvider;
  }

  const envProvider = process.env.LIGHTCODE_WEB_SEARCH_PROVIDER?.trim();
  if (envProvider === "brave" || envProvider === "tavily") {
    return envProvider;
  }

  if (process.env.BRAVE_SEARCH_API_KEY) {
    return "brave";
  }

  if (process.env.TAVILY_API_KEY) {
    return "tavily";
  }

  return "auto";
}

function errorOutput({
  parsedInput,
  provider,
  code,
  message,
}: {
  parsedInput: z.infer<typeof webSearchInputSchema>;
  provider: string;
  code: string;
  message: string;
}): WebSearchOutput {
  return webSearchOutputSchema.parse({
    ok: false,
    query: parsedInput.query,
    provider,
    results: [],
    totalResults: 0,
    error: {
      code,
      message,
    },
  });
}

function parseBraveResults(payload: unknown, maxResults: number): WebSearchResult[] {
  if (!isRecord(payload) || !isRecord(payload.web)) {
    return [];
  }

  return getArrayProperty(payload.web, "results")
    .slice(0, maxResults)
    .filter(isRecord)
    .map((entry) => ({
      title: getStringProperty(entry, "title"),
      url: getStringProperty(entry, "url"),
      snippet: getStringProperty(entry, "description"),
      source: getStringProperty(entry, "profile") || null,
    }))
    .filter((entry) => entry.title && entry.url);
}

function parseTavilyResults(payload: unknown, maxResults: number): WebSearchResult[] {
  if (!isRecord(payload)) {
    return [];
  }

  return getArrayProperty(payload, "results")
    .slice(0, maxResults)
    .filter(isRecord)
    .map((entry) => ({
      title: getStringProperty(entry, "title"),
      url: getStringProperty(entry, "url"),
      snippet: getStringProperty(entry, "content"),
      source: "tavily",
    }))
    .filter((entry) => entry.title && entry.url);
}

async function searchBrave(
  parsedInput: z.infer<typeof webSearchInputSchema>,
): Promise<WebSearchOutput> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey) {
    return errorOutput({
      parsedInput,
      provider: "brave",
      code: "not_configured",
      message: "Set BRAVE_SEARCH_API_KEY to use web_search with the Brave provider.",
    });
  }

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", parsedInput.query);
  url.searchParams.set("count", String(Math.min(parsedInput.maxResults, 20)));

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "x-subscription-token": apiKey,
    },
  });

  if (!response.ok) {
    return errorOutput({
      parsedInput,
      provider: "brave",
      code: "http_error",
      message: `Brave Search returned HTTP ${response.status}.`,
    });
  }

  const results = parseBraveResults(await response.json(), parsedInput.maxResults);

  return webSearchOutputSchema.parse({
    ok: true,
    query: parsedInput.query,
    provider: "brave",
    results,
    totalResults: results.length,
    error: null,
  });
}

async function searchTavily(
  parsedInput: z.infer<typeof webSearchInputSchema>,
): Promise<WebSearchOutput> {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) {
    return errorOutput({
      parsedInput,
      provider: "tavily",
      code: "not_configured",
      message: "Set TAVILY_API_KEY to use web_search with the Tavily provider.",
    });
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      api_key: apiKey,
      query: parsedInput.query,
      max_results: parsedInput.maxResults,
      search_depth: "basic",
    }),
  });

  if (!response.ok) {
    return errorOutput({
      parsedInput,
      provider: "tavily",
      code: "http_error",
      message: `Tavily returned HTTP ${response.status}.`,
    });
  }

  const results = parseTavilyResults(await response.json(), parsedInput.maxResults);

  return webSearchOutputSchema.parse({
    ok: true,
    query: parsedInput.query,
    provider: "tavily",
    results,
    totalResults: results.length,
    error: null,
  });
}

export async function executeWebSearch(input: WebSearchInput): Promise<WebSearchOutput> {
  const parsedInput = webSearchInputSchema.parse(input);
  const provider = configuredProvider(parsedInput.provider);

  try {
    if (provider === "brave") {
      return await searchBrave(parsedInput);
    }

    if (provider === "tavily") {
      return await searchTavily(parsedInput);
    }

    return errorOutput({
      parsedInput,
      provider: "auto",
      code: "not_configured",
      message:
        "Configure LIGHTCODE_WEB_SEARCH_PROVIDER plus BRAVE_SEARCH_API_KEY or TAVILY_API_KEY to use web_search.",
    });
  } catch (error) {
    return errorOutput({
      parsedInput,
      provider,
      code: "search_failed",
      message: error instanceof Error ? error.message : "Web search failed.",
    });
  }
}
