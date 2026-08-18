import { z } from "zod";
import { truncateText } from "../common/output-utils";
import { webFetchInputSchema, webFetchOutputSchema } from "./schema";

type WebFetchInput = z.input<typeof webFetchInputSchema>;
type WebFetchOutput = z.infer<typeof webFetchOutputSchema>;

const htmlEntityMap = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
} satisfies Record<string, string>;

function decodeHtmlEntities(value: string) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase();

    if (normalized.startsWith("#x")) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    if (normalized.startsWith("#")) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    return htmlEntityMap[normalized as keyof typeof htmlEntityMap] ?? match;
  });
}

function extractTitle(html: string) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!titleMatch) {
    return null;
  }

  return decodeHtmlEntities(titleMatch[1].replace(/\s+/g, " ").trim()) || null;
}

function normalizeHtmlToText(html: string) {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|section|article|h[1-6]|li|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function normalizeContentToText(content: string, contentType: string | null) {
  if (contentType?.toLowerCase().includes("html")) {
    return normalizeHtmlToText(content);
  }

  return content.replace(/\r\n/g, "\n").trim();
}

function errorOutput({
  parsedInput,
  code,
  message,
}: {
  parsedInput: z.infer<typeof webFetchInputSchema>;
  code: string;
  message: string;
}): WebFetchOutput {
  return webFetchOutputSchema.parse({
    ok: false,
    url: parsedInput.url,
    finalUrl: null,
    status: null,
    statusText: null,
    contentType: null,
    title: null,
    text: "",
    truncated: false,
    fetchedAt: new Date().toISOString(),
    error: {
      code,
      message,
    },
  });
}

export async function executeWebFetch(
  input: WebFetchInput,
  options: { signal?: AbortSignal; fetch?: typeof globalThis.fetch } = {},
): Promise<WebFetchOutput> {
  const parsedInput = webFetchInputSchema.parse(input);
  const timeoutSignal = AbortSignal.timeout(parsedInput.timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  try {
    const response = await (options.fetch ?? globalThis.fetch)(parsedInput.url, {
      redirect: "follow",
      signal,
      headers: {
        "user-agent": "Lightcode/1.0",
        accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
      },
    });
    const contentType = response.headers.get("content-type");
    const rawText = await response.text();
    const normalizedText = normalizeContentToText(rawText, contentType);
    const truncated = truncateText(normalizedText, parsedInput.maxChars);

    return webFetchOutputSchema.parse({
      ok: response.ok,
      url: parsedInput.url,
      finalUrl: response.url,
      status: response.status,
      statusText: response.statusText,
      contentType,
      title: contentType?.toLowerCase().includes("html")
        ? extractTitle(rawText)
        : null,
      text: truncated.text,
      truncated: truncated.truncated,
      fetchedAt: new Date().toISOString(),
      error: response.ok
        ? null
        : {
            code: "http_error",
            message: `HTTP ${response.status} ${response.statusText}`.trim(),
          },
    });
  } catch (error) {
    return errorOutput({
      parsedInput,
      code: options.signal?.aborted
        ? "aborted"
        : timeoutSignal.aborted
          ? "timeout"
          : "fetch_failed",
      message: error instanceof Error ? error.message : "Unable to fetch URL.",
    });
  }
}
