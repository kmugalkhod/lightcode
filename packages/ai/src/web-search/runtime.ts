import { z } from "zod";
import { networkFetch } from "@lightcode/shared/network";
import {
  loadLightcodeConfig,
  type LightcodeResolvedConfig,
} from "../config/lightcode-config";
import {
  readStoredCredentials,
  type StoredCredentials,
} from "../config/credentials";
import {
  resolveWebSearchApiKeys,
  type ResolvedWebSearchConfig,
} from "./config";
import {
  webSearchInputSchema,
  webSearchOutputSchema,
  type webSearchProviderSchema,
} from "./schema";

type WebSearchInput = z.input<typeof webSearchInputSchema>;
type WebSearchOutput = z.infer<typeof webSearchOutputSchema>;
type WebSearchProvider = z.infer<typeof webSearchProviderSchema>;
type WebSearchResult = WebSearchOutput["results"][number];

export type WebSearchFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ExecuteWebSearchOptions {
  config?: ResolvedWebSearchConfig;
  credentials?: StoredCredentials;
  env?: Record<string, string | undefined>;
  fetch?: WebSearchFetch;
  signal?: AbortSignal;
  cwd?: string;
  /** Stable user-turn key used to enforce maxUsesPerTurn locally. */
  turnKey?: string;
}

interface LocalSearchRuntime {
  apiKey: string;
  fetch: WebSearchFetch;
  signal: AbortSignal;
  maxCharactersPerResult: number;
}

const localUsesByTurn = new Map<string, number>();

export function clearWebSearchTurnUses(): void {
  localUsesByTurn.clear();
}

function consumeLocalSearchUse(
  turnKey: string | undefined,
  maxUsesPerTurn: number,
): boolean {
  if (!turnKey) {
    return true;
  }
  const used = localUsesByTurn.get(turnKey) ?? 0;
  if (used >= maxUsesPerTurn) {
    return false;
  }
  if (localUsesByTurn.size >= 1_000 && !localUsesByTurn.has(turnKey)) {
    const oldest = localUsesByTurn.keys().next().value;
    if (typeof oldest === "string") {
      localUsesByTurn.delete(oldest);
    }
  }
  localUsesByTurn.set(turnKey, used + 1);
  return true;
}

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

function truncate(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters
    ? value
    : `${value.slice(0, Math.max(0, maxCharacters - 1))}…`;
}

function resolveRuntimeConfig(
  options: ExecuteWebSearchOptions,
): LightcodeResolvedConfig["webSearch"] {
  if (options.config) {
    return options.config;
  }

  return loadLightcodeConfig({
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
  }).config.webSearch;
}

function resolveLocalBackend({
  requestedProvider,
  config,
  braveKey,
  tavilyKey,
}: {
  requestedProvider: WebSearchProvider;
  config: ResolvedWebSearchConfig;
  braveKey: string | undefined;
  tavilyKey: string | undefined;
}): WebSearchProvider | "disabled" | "provider" {
  if (requestedProvider !== "auto") {
    return requestedProvider;
  }

  if (
    config.backend === "brave" ||
    config.backend === "tavily" ||
    config.backend === "disabled" ||
    config.backend === "provider"
  ) {
    return config.backend;
  }

  if (braveKey) {
    return "brave";
  }

  if (tavilyKey) {
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

function parseBraveResults(
  payload: unknown,
  maxResults: number,
  maxCharacters: number,
): WebSearchResult[] {
  if (!isRecord(payload) || !isRecord(payload.web)) {
    return [];
  }

  return getArrayProperty(payload.web, "results")
    .slice(0, maxResults)
    .filter(isRecord)
    .map((entry) => ({
      title: getStringProperty(entry, "title"),
      url: getStringProperty(entry, "url"),
      snippet: truncate(getStringProperty(entry, "description"), maxCharacters),
      source: getStringProperty(entry, "profile") || null,
    }))
    .filter((entry) => entry.title && entry.url);
}

function parseTavilyResults(
  payload: unknown,
  maxResults: number,
  maxCharacters: number,
): WebSearchResult[] {
  if (!isRecord(payload)) {
    return [];
  }

  return getArrayProperty(payload, "results")
    .slice(0, maxResults)
    .filter(isRecord)
    .map((entry) => ({
      title: getStringProperty(entry, "title"),
      url: getStringProperty(entry, "url"),
      snippet: truncate(getStringProperty(entry, "content"), maxCharacters),
      source: "tavily",
    }))
    .filter((entry) => entry.title && entry.url);
}

async function searchBrave(
  parsedInput: z.infer<typeof webSearchInputSchema>,
  runtime: LocalSearchRuntime,
): Promise<WebSearchOutput> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", parsedInput.query);
  url.searchParams.set("count", String(Math.min(parsedInput.maxResults, 20)));

  const response = await runtime.fetch(url, {
    headers: {
      accept: "application/json",
      "x-subscription-token": runtime.apiKey,
    },
    signal: runtime.signal,
  });

  if (!response.ok) {
    return errorOutput({
      parsedInput,
      provider: "brave",
      code: "http_error",
      message: `Brave Search returned HTTP ${response.status}.`,
    });
  }

  const results = parseBraveResults(
    await response.json(),
    parsedInput.maxResults,
    runtime.maxCharactersPerResult,
  );

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
  runtime: LocalSearchRuntime,
): Promise<WebSearchOutput> {
  const response = await runtime.fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      api_key: runtime.apiKey,
      query: parsedInput.query,
      max_results: parsedInput.maxResults,
      search_depth: "basic",
      include_raw_content: false,
    }),
    signal: runtime.signal,
  });

  if (!response.ok) {
    return errorOutput({
      parsedInput,
      provider: "tavily",
      code: "http_error",
      message: `Tavily returned HTTP ${response.status}.`,
    });
  }

  const results = parseTavilyResults(
    await response.json(),
    parsedInput.maxResults,
    runtime.maxCharactersPerResult,
  );

  return webSearchOutputSchema.parse({
    ok: true,
    query: parsedInput.query,
    provider: "tavily",
    results,
    totalResults: results.length,
    error: null,
  });
}

/**
 * Executes only local Brave/Tavily search. Provider-native tools are attached
 * to the model before generation and therefore never pass through this path.
 */
export async function executeWebSearch(
  input: WebSearchInput,
  options: ExecuteWebSearchOptions = {},
): Promise<WebSearchOutput> {
  const env = options.env ?? process.env;
  const config = resolveRuntimeConfig(options);
  const credentials = options.credentials ?? readStoredCredentials(env);
  const keys = resolveWebSearchApiKeys({ env, storedCredentials: credentials });
  const parsedInput = webSearchInputSchema.parse({
    ...input,
    maxResults:
      isRecord(input) && input.maxResults !== undefined
        ? input.maxResults
        : config.maxResults,
  });
  const provider = resolveLocalBackend({
    requestedProvider: parsedInput.provider,
    config,
    braveKey: keys.brave,
    tavilyKey: keys.tavily,
  });
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  try {
    if (provider === "brave" && keys.brave) {
      if (!consumeLocalSearchUse(options.turnKey, config.maxUsesPerTurn)) {
        return errorOutput({
          parsedInput,
          provider,
          code: "max_uses_exceeded",
          message: `Web search is limited to ${config.maxUsesPerTurn} uses per turn.`,
        });
      }
      return await searchBrave(parsedInput, {
        apiKey: keys.brave,
        fetch: options.fetch ?? networkFetch,
        signal,
        maxCharactersPerResult: config.maxCharactersPerResult,
      });
    }

    if (provider === "tavily" && keys.tavily) {
      if (!consumeLocalSearchUse(options.turnKey, config.maxUsesPerTurn)) {
        return errorOutput({
          parsedInput,
          provider,
          code: "max_uses_exceeded",
          message: `Web search is limited to ${config.maxUsesPerTurn} uses per turn.`,
        });
      }
      return await searchTavily(parsedInput, {
        apiKey: keys.tavily,
        fetch: options.fetch ?? networkFetch,
        signal,
        maxCharactersPerResult: config.maxCharactersPerResult,
      });
    }

    if (provider === "provider") {
      return errorOutput({
        parsedInput,
        provider,
        code: "provider_managed",
        message:
          "Provider-native web search must be attached before the model request; the local runtime cannot execute it.",
      });
    }

    if (provider === "disabled") {
      return errorOutput({
        parsedInput,
        provider,
        code: "disabled",
        message: "Web search is disabled in Lightcode settings.",
      });
    }

    const credentialName =
      provider === "brave" ? "BRAVE_SEARCH_API_KEY" : "TAVILY_API_KEY";
    return errorOutput({
      parsedInput,
      provider,
      code: "not_configured",
      message:
        provider === "brave" || provider === "tavily"
          ? `Set ${credentialName} or save the corresponding search credential.`
          : "Configure BRAVE_SEARCH_API_KEY or TAVILY_API_KEY to use local web_search.",
    });
  } catch (error) {
    const externallyAborted = options.signal?.aborted ?? false;
    const timedOut = timeoutSignal.aborted && !externallyAborted;
    return errorOutput({
      parsedInput,
      provider,
      code: timedOut ? "timeout" : externallyAborted ? "aborted" : "search_failed",
      message: timedOut
        ? `Web search timed out after ${config.timeoutMs}ms.`
        : externallyAborted
          ? "Web search was aborted."
          : error instanceof Error
            ? error.message
            : "Web search failed.",
    });
  }
}
